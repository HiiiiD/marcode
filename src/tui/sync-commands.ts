import * as os from 'node:os';
import { configPath, loadConfig, patchConfig } from '../host/config-file';
import { marcodeHome } from '../host/workspace-dir';
import { readCredentials, removeCredentials, writeCredentials, type SyncCredentials } from '../sync/credentials';
import { SyncClient } from '../sync/sync-client';
import type { CliCommand } from './cli';

type SyncCommand = Extract<CliCommand, { kind: 'sync' }>;
export interface SyncIo { home?: string; out(line: string): void; err(line: string): void }

const realIo: SyncIo = { out: (l) => console.log(l), err: (l) => console.error(l) };

function split(args: string[]): { operands: string[]; name?: string } {
  const operands: string[] = [];
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') { name = args[++i]; continue; }
    operands.push(args[i]);
  }
  return { operands, name };
}

async function rememberServer(home: string, creds: SyncCredentials): Promise<void> {
  const file = configPath(home);
  const raw = (await loadConfig(file).catch(() => undefined))?.raw as Record<string, unknown> | undefined;
  const previous = raw && typeof raw.sync === 'object' && raw.sync !== null ? raw.sync as Record<string, unknown> : {};
  await patchConfig(file, { sync: { ...previous, server: creds.server, deviceName: creds.deviceName } });
}

const ago = (ms: number): string => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) { return 'just now'; }
  if (minutes < 60) { return `${minutes} min ago`; }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

export async function runSyncCommand(cmd: SyncCommand, io: SyncIo = realIo): Promise<number> {
  const home = io.home ?? marcodeHome();
  const { operands, name } = split(cmd.args);
  const deviceName = name ?? os.hostname();

  if (cmd.action === 'setup' || cmd.action === 'join') {
    if (await readCredentials(home)) {
      io.err('This machine is already paired. Run `marcode sync leave` first to pair it with another server.');
      return 2;
    }
    const [server, code] = operands;
    const result = cmd.action === 'setup'
      ? await SyncClient.enroll(server, code, deviceName)
      : await SyncClient.join(server, code, deviceName);
    if (!result.ok) { io.err(`marcode sync ${cmd.action}: ${result.error}`); return 1; }
    await writeCredentials(home, result.value);
    await rememberServer(home, result.value);
    io.out(`Paired "${result.value.deviceName}" with ${result.value.server}.`);
    if (cmd.action === 'setup') { io.out('Add another device with `marcode sync pair` here, then `marcode sync join` there.'); }
    return 0;
  }

  const creds = await readCredentials(home);
  if (!creds) {
    io.err('This machine is not paired. Run `marcode sync setup <url> <bootstrap-code>` (first device) or `marcode sync join <url> <pairing-code>`.');
    return 2;
  }
  const client = new SyncClient(creds);

  switch (cmd.action) {
    case 'pair': {
      const result = await client.createPairing();
      if (!result.ok) { io.err(`marcode sync pair: ${result.error}`); return 1; }
      await writeCredentials(home, client.credentials);
      io.out(`On the new device run:\n  marcode sync join ${creds.server} ${result.value.code}`);
      io.out(`The code works once and expires at ${new Date(result.value.expiresAt).toLocaleTimeString()}.`);
      return 0;
    }
    case 'devices': {
      const result = await client.devices();
      if (!result.ok) { io.err(`marcode sync devices: ${result.error}`); return 1; }
      for (const d of result.value) {
        const tags = [d.deviceId === creds.deviceId ? 'this device' : '', d.revokedAt !== undefined ? 'revoked' : ''].filter(Boolean);
        io.out(`${d.name.padEnd(20)} ${d.deviceId.slice(0, 8)}  last seen ${ago(d.lastSeenAt).padEnd(12)} ${tags.join(', ')}`.trimEnd());
      }
      return 0;
    }
    case 'revoke': {
      const prefix = operands[0] ?? '';
      const listed = await client.devices();
      if (!listed.ok) { io.err(`marcode sync revoke: ${listed.error}`); return 1; }
      const matches = prefix === '' ? [] : listed.value.filter((d) => d.deviceId.startsWith(prefix));
      if (matches.length !== 1) {
        io.err(matches.length === 0 ? `No device id starts with "${prefix}".` : `"${prefix}" matches ${matches.length} devices; type more of the id.`);
        return 2;
      }
      if (matches[0].deviceId === creds.deviceId) { io.err('That is this device. Run `marcode sync leave` to remove it.'); return 2; }
      // Already revoked: an earlier revoke whose key rotation did not finish. Rotating again completes it.
      const result = matches[0].revokedAt === undefined ? await client.revoke(matches[0].deviceId) : await client.rotateKey();
      if (!result.ok) { io.err(`marcode sync revoke: ${result.error}`); return 1; }
      await writeCredentials(home, result.value);
      io.out(`Revoked "${matches[0].name}". New records use a key it never had.`);
      return 0;
    }
    case 'status': {
      const result = await client.devices();
      io.out(`server   ${creds.server}`);
      io.out(`device   ${creds.deviceName} (${creds.deviceId.slice(0, 8)})`);
      io.out(result.ok ? `reachable, ${result.value.filter((d) => d.revokedAt === undefined).length} active devices` : `not reachable: ${result.error}`);
      return result.ok ? 0 : 1;
    }
    case 'leave': {
      const result = await client.leave();
      await removeCredentials(home);
      io.out(result.ok ? 'This device left the sync server.' : `Removed this device's credentials; the server could not be told (${result.error}).`);
      return 0;
    }
    default:
      return 2;
  }
}

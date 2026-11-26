import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { encodeCode } from '../sync/pairing-code';
import { hashSecret } from './auth';
import { startSyncServer } from './server';
import { SyncStore } from './store';

export type ServerArgs =
  | { kind: 'serve'; data: string; port: number; host: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const SERVER_USAGE = 'marcode sync-server [--data <dir>] [--port 8787] [--host 127.0.0.1]';

export function parseServerArgs(args: string[]): ServerArgs {
  const out = { kind: 'serve' as const, data: path.resolve('marcode-sync'), port: 8787, host: '127.0.0.1' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') { return { kind: 'help' }; }
    const value = args[i + 1];
    if (flag !== '--data' && flag !== '--port' && flag !== '--host') { return { kind: 'error', message: `unknown option ${flag}` }; }
    if (value === undefined) { return { kind: 'error', message: `${flag} needs a value` }; }
    i++;
    if (flag === '--data') { out.data = path.resolve(value); }
    if (flag === '--host') { out.host = value; }
    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) { return { kind: 'error', message: `--port must be 0..65535 (got ${value})` }; }
      out.port = port;
    }
  }
  return out;
}

/** Serves until SIGINT/SIGTERM. While no device is enrolled, every start prints a fresh one-time bootstrap code. */
export async function runSyncServer(args: string[], io: { out(line: string): void; err(line: string): void }): Promise<number> {
  const parsed = parseServerArgs(args);
  if (parsed.kind === 'help') { io.out(SERVER_USAGE); return 0; }
  if (parsed.kind === 'error') { io.err(`marcode sync-server: ${parsed.message}\n${SERVER_USAGE}`); return 2; }
  fs.mkdirSync(parsed.data, { recursive: true, mode: 0o700 });
  const store = new SyncStore(path.join(parsed.data, 'sync.sqlite'));
  if (!store.enrolled()) {
    const bytes = randomBytes(16);
    store.setBootstrap(hashSecret(bytes));
    io.out(`No device enrolled yet. On your first device run:\n  marcode sync setup <this server's https URL> ${encodeCode('MRB', bytes)}`);
  }
  let server: Awaited<ReturnType<typeof startSyncServer>>;
  try {
    server = await startSyncServer({ store, host: parsed.host, port: parsed.port, log: io.err });
  } catch (err) {
    store.close();
    io.err(`marcode sync-server: cannot listen on ${parsed.host}:${parsed.port}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  io.out(`marcode sync-server listening on ${server.url} (data: ${parsed.data}). Put HTTPS in front of it; see docs/sync.md.`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.close();
  store.close();
  return 0;
}

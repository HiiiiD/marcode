import * as fs from 'node:fs/promises';
import { daemonInfoPath, readDaemonInfo, type DaemonInfo } from '../daemon/daemon-info';
import { requestShutdown } from '../daemon/request-shutdown';
import type { ClientKind, DaemonIdentity } from '../protocol/daemon-wire';
import { DEFAULT_RETRY, helloFrame, SocketDaemonClient, type ClientHooks, type DaemonClient, type Opened } from './daemon-client';
import { openLink, type HelloFrame } from './daemon-link';
import { discover } from './discover';
import { acquireSpawnLock } from './spawn-lock';
import { decideAttach } from './version-policy';

type FallbackReason = 'disabled' | 'newer-daemon' | 'busy-daemon' | 'spawn-failed' | 'rejected';
type Fallback = { kind: 'fallback'; reason: FallbackReason; message: string };

export type ConnectResult = { kind: 'attached'; client: DaemonClient } | Fallback;

export interface ConnectOptions {
  workspaceDir: string;
  clientKind: ClientKind;
  roots: string[];
  defaultCwd: string;
  identity: DaemonIdentity;
  hooks: ClientHooks;
  spawn(): Promise<void>;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Reconnect backoff base; attempt n waits base * 2^n. */
  retryBaseMs?: number;
}

const POLL_MS = 100;
const GONE_WAIT_MS = 5_000;

const fallback = (reason: FallbackReason, message: string): Fallback => ({ kind: 'fallback', reason, message });
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms).unref(); });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function waitGone(dir: string, token: string): Promise<boolean> {
  const end = Date.now() + GONE_WAIT_MS;
  while (Date.now() < end) {
    if ((await discover(dir))?.token !== token) { return true; }
    await sleep(POLL_MS);
  }
  return false;
}

/** Only a record this client already failed to reach is removed, so a fresh daemon's file survives. */
async function removeStale(dir: string, token: string): Promise<void> {
  if ((await readDaemonInfo(dir))?.token !== token) { return; }
  await fs.rm(daemonInfoPath(dir), { force: true }).catch(() => { /* the spawned daemon overwrites it anyway */ });
}

async function establish(opts: ConnectOptions, cancelled: () => boolean = () => false): Promise<Opened | Fallback> {
  const { workspaceDir: dir, identity } = opts;
  await fs.mkdir(dir, { recursive: true }).catch(() => { /* discover and spawn report the failure */ });
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const hello = (info: DaemonInfo): HelloFrame => helloFrame(info.token, {
    clientKind: opts.clientKind, roots: opts.roots, defaultCwd: opts.defaultCwd,
  }, identity);
  const stale = new Set<string>();
  let rediscovered = false;
  let spawned = false;
  let release: (() => Promise<void>) | undefined;

  try {
    while (Date.now() < deadline && !cancelled()) {
      const info = await discover(dir);
      if (info && !stale.has(info.token)) {
        const decision = decideAttach(info.protocolVersion, identity.protocolVersion);
        if (decision === 'refuse-newer') {
          return fallback('newer-daemon', 'The background host is a newer Marcode version; update this client');
        }
        if (decision === 'replace') {
          const answer = await requestShutdown(info.endpoint, info.token, opts.handshakeTimeoutMs ?? 3_000);
          if (answer === 'busy') {
            return fallback('busy-daemon', 'A newer Marcode build is needed but sessions are running; close them or restart');
          }
          if (answer === 'bad-token') { return fallback('rejected', 'The background host refused to shut down (bad token)'); }
          if (answer === 'bye') {
            if (!(await waitGone(dir, info.token))) {
              return fallback('spawn-failed', 'The old background host did not exit');
            }
            continue;
          }
          stale.add(info.token);
        } else {
          const r = await openLink(info.endpoint, hello(info), opts.handshakeTimeoutMs);
          if ('link' in r) {
            if (cancelled()) { r.link.destroy(); break; }
            return r;
          }
          if ('rejected' in r) {
            const { reason } = r.rejected;
            if ((reason === 'bad-token' || reason === 'protocol-mismatch') && !rediscovered) {
              rediscovered = true;
              continue;
            }
            return fallback('rejected', `The background host rejected this client (${reason})`);
          }
          stale.add(info.token);
        }
      }

      if (!spawned) {
        release = await acquireSpawnLock(dir);
        if (release) {
          const again = await discover(dir);
          if (again && !stale.has(again.token)) {
            await release();
            release = undefined;
            continue;
          }
          if (again) { await removeStale(dir, again.token); }
          spawned = true;
          try {
            await opts.spawn();
          } catch (err) {
            return fallback('spawn-failed', `Could not start the background host: ${errorText(err)}`);
          }
          // The lock stays held while the spawned daemon comes up, so a second client cannot spawn a rival.
          continue;
        }
      }
      await sleep(POLL_MS);
    }
    return fallback('spawn-failed', 'The background host did not start in time');
  } catch (err) {
    return fallback('spawn-failed', `Could not reach the background host: ${errorText(err)}`);
  } finally {
    await release?.();
  }
}

export async function connectOrSpawn(opts: ConnectOptions): Promise<ConnectResult> {
  const first = await establish(opts);
  if ('kind' in first) { return first; }
  const reopen = async (cancelled: () => boolean): Promise<Opened | undefined> => {
    const r = await establish(opts, cancelled);
    return 'kind' in r ? undefined : r;
  };
  const retry = { ...DEFAULT_RETRY, baseMs: opts.retryBaseMs ?? DEFAULT_RETRY.baseMs };
  return { kind: 'attached', client: new SocketDaemonClient(first, opts.hooks, reopen, retry) };
}

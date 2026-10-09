import * as fs from 'node:fs/promises';
import { daemonInfoPath, readDaemonInfo, type DaemonInfo } from '../daemon/daemon-info';
import { requestShutdown } from '../daemon/request-shutdown';
import type { ClientKind, DaemonIdentity } from '../protocol/daemon-wire';
import { DEFAULT_RETRY, helloFrame, SocketDaemonClient, type ClientHooks, type DaemonClient, type Opened } from './daemon-client';
import { DEFAULT_HANDSHAKE_TIMEOUT_MS, openLink, type HelloFrame } from './daemon-link';
import { discover } from './discover';
import { acquireSpawnLock } from './spawn-lock';
import { decideAttach } from './version-policy';

type FallbackReason = 'disabled' | 'newer-daemon' | 'busy-daemon' | 'unresponsive-daemon' | 'spawn-failed' | 'rejected';
type Fallback = { kind: 'fallback'; reason: FallbackReason; message: string };

/** `warnings` are things the user should know about the daemon this client attached to. */
export type ConnectResult = { kind: 'attached'; client: DaemonClient; warnings?: string[] } | Fallback;

export const STALE_CONFIG_WARNING = 'The background host is running with an older config.json; run `marcode daemon --stop` once sessions finish';

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
  /** Budget of one reconnect attempt, so the time to `lost` stays bounded. */
  reconnectTimeoutMs?: number;
  /** reloadSignature of this client's config.json; an idle daemon started with another one is replaced. */
  configSignature?: string;
}

const POLL_MS = 100;
const GONE_WAIT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 3_000;

const fallback = (reason: FallbackReason, message: string): Fallback => ({ kind: 'fallback', reason, message });
// Never unref'd: while a spawned daemon boots this poll is the only thing keeping a fresh client process alive.
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function waitGone(dir: string, token: string): Promise<boolean> {
  const end = Date.now() + GONE_WAIT_MS;
  while (Date.now() < end) {
    if ((await discover(dir))?.token !== token) { return true; }
    await sleep(POLL_MS);
  }
  return false;
}

/** Only a record this client positively failed to reach is removed, so a fresh daemon's file survives. */
async function removeStale(dir: string, token: string): Promise<void> {
  if ((await readDaemonInfo(dir))?.token !== token) { return; }
  await fs.rm(daemonInfoPath(dir), { force: true }).catch(() => { /* the spawned daemon overwrites it anyway */ });
}

interface EstablishOpts {
  timeoutMs: number;
  cancelled: () => boolean;
  /** Shared across reconnect attempts: a daemon spawned by an earlier attempt may still be booting. */
  spawnGuard: { at: number };
  warnings: string[];
}

async function establish(opts: ConnectOptions, run: EstablishOpts): Promise<Opened | Fallback> {
  const { workspaceDir: dir, identity } = opts;
  const { cancelled, spawnGuard } = run;
  await fs.mkdir(dir, { recursive: true }).catch(() => { /* discover and spawn report the failure */ });
  const deadline = Date.now() + run.timeoutMs;
  const handshakeMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  const hello = (info: DaemonInfo): HelloFrame => helloFrame(info.token, {
    clientKind: opts.clientKind, roots: opts.roots, defaultCwd: opts.defaultCwd,
  }, identity);
  const stale = new Set<string>();
  const keepConfig = new Set<string>();
  let rediscovered = false;
  let unresponsive = false;
  let release: (() => Promise<void>) | undefined;

  try {
    while (Date.now() < deadline && !cancelled()) {
      const info = await discover(dir);
      if (info && !stale.has(info.token)) {
        const decision = decideAttach(info.protocolVersion, identity.protocolVersion);
        const oldConfig = decision === 'attach' && opts.configSignature !== undefined && info.configSignature !== undefined
          && info.configSignature !== opts.configSignature && !keepConfig.has(info.token);
        if (decision === 'refuse-newer') {
          return fallback('newer-daemon', 'The background host is a newer Marcode version; update this client');
        }
        if (decision === 'replace' || oldConfig) {
          const answer = await requestShutdown(info.endpoint, info.token, handshakeMs);
          if (answer === 'busy' && oldConfig) {
            keepConfig.add(info.token);
            run.warnings.push(STALE_CONFIG_WARNING);
            continue;
          }
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
          if (answer === 'unreachable') { stale.add(info.token); }
        } else {
          const r = await openLink(info.endpoint, hello(info), handshakeMs);
          if ('link' in r) {
            if (cancelled()) { r.link.destroy(); break; }
            spawnGuard.at = -Infinity;
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
          if (r.failed === 'unreachable') { stale.add(info.token); }
        }
        // A live record that did not answer is a blocked daemon, not a missing one: wait, never replace it.
        if (!stale.has(info.token)) {
          unresponsive = true;
          await sleep(POLL_MS);
          continue;
        }
      }

      const mayspawn = !release && Date.now() - spawnGuard.at > (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (mayspawn && !cancelled()) {
        release = await acquireSpawnLock(dir);
        if (release) {
          const again = await discover(dir);
          if ((again && !stale.has(again.token)) || cancelled()) {
            await release();
            release = undefined;
            continue;
          }
          if (again) { await removeStale(dir, again.token); }
          spawnGuard.at = Date.now();
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
    return unresponsive
      ? fallback('unresponsive-daemon', 'The background host is not responding; it may be busy. Try again in a moment.')
      : fallback('spawn-failed', 'The background host did not start in time');
  } catch (err) {
    return fallback('spawn-failed', `Could not reach the background host: ${errorText(err)}`);
  } finally {
    await release?.();
  }
}

export async function connectOrSpawn(opts: ConnectOptions): Promise<ConnectResult> {
  const spawnGuard = { at: -Infinity };
  const warnings: string[] = [];
  const first = await establish(opts, { timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, cancelled: () => false, spawnGuard, warnings });
  if ('kind' in first) { return first; }
  const reopen = async (cancelled: () => boolean): Promise<Opened | undefined> => {
    const r = await establish(opts, {
      timeoutMs: opts.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS, cancelled, spawnGuard, warnings: [],
    });
    return 'kind' in r ? undefined : r;
  };
  const retry = { ...DEFAULT_RETRY, baseMs: opts.retryBaseMs ?? DEFAULT_RETRY.baseMs };
  const client = new SocketDaemonClient(first, opts.hooks, reopen, retry);
  return warnings.length > 0 ? { kind: 'attached', client, warnings } : { kind: 'attached', client };
}

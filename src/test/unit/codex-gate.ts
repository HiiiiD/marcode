// The opt-in gate every real-`codex` test shares.
//
// These tests need a real binary AND a signed-in account, so a suite built on
// them skips (never fails) when either is absent — a contributor without
// Codex, or one who installed it but never ran `codex login`, must still get a
// green `yarn test:unit`. `codexAvailable()` is a cheap `codex --version`
// probe, not a spawn-and-wait, so the no-binary case costs nothing; only once
// that passes does a suite pay for one real `initialize` + `account/read`
// round trip.
//
// Not a `*.test.ts` file, so mocha's spec glob does not load it. It lives here
// rather than being copied into each suite because "gated exactly like the
// other one" is a promise two copies cannot keep.

import { execFileSync, spawn as spawnChildProcess } from 'node:child_process';
import { AppServer, type Duplex } from '../../providers/codex/app-server';
import type { AgentEvent, AgentRun } from '../../providers/types';
import type { AccountReadResponse } from '../../providers/codex/wire';

export function codexAvailable(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Real, child-process-backed spawn — same shape as `codex-provider.ts`'s `defaultSpawn`. */
export function spawnCodex(): Duplex {
  const child = spawnChildProcess('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    kill: () => { child.kill(); },
  };
}

/** Races a promise against a timeout so a hung real process can never block cleanup. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${label} timed out after ${ms}ms`)); }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * The one `initialize` + `account/read` round trip a suite pays for —
 * `suiteSetup` calls this exactly once, never per test. `codex --version`
 * succeeding says only that the binary exists; a CLI installed but never
 * `codex login`-ed answers every RPC just fine and only `account/read`
 * reveals that. `reason` is what `suiteSetup` logs, so a "not signed in" skip
 * reads differently from a "no binary" skip in the test output — a
 * silently-pending test a contributor expected to run is its own confusion.
 */
export async function probeAuth(): Promise<{ signedIn: boolean; reason?: string }> {
  const server = new AppServer(spawnCodex());
  try {
    await withTimeout(server.request('initialize', {
      clientInfo: { name: 'hiiiid-code-smoke-test', title: null, version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
    }), 20_000, 'initialize');
    const account = await withTimeout(
      server.request<AccountReadResponse>('account/read', {}),
      20_000,
      'account/read',
    );
    // `account.account` — not `requiresOpenaiAuth` — is the real "signed in"
    // signal. Measured live on codex-cli 0.147.0 against this repo's own
    // signed-in ChatGPT Plus account: `account/read` answered
    // `{"account":{"type":"chatgpt","email":"…","planType":"plus"},
    // "requiresOpenaiAuth":true}` — `requiresOpenaiAuth` was `true` even
    // though the account was fully populated and `model/list` genuinely
    // returned six real models. `codex-provider.ts`'s `fetchModels()` and
    // `wire.ts`'s `AccountReadResponse` doc were both corrected to this
    // reading in 327665a; the check below is the same one `fetchModels` now
    // makes.
    if (!account.account) {
      return { signedIn: false, reason: 'codex is installed but not signed in — run `codex login`' };
    }
    return { signedIn: true };
  } catch (err) {
    return { signedIn: false, reason: `codex auth probe failed: ${errorMessage(err)}` };
  } finally {
    server.dispose();
  }
}

/**
 * Drains `run.events` until a `turn-end` arrives or `maxMs` elapses, whichever
 * comes first. A plain `for await` would hang the test (and the child process)
 * forever if the real turn never ends; racing each `next()` against a deadline
 * means a stuck server yields an empty/partial event list instead of an
 * unkillable test.
 */
export async function collectUntilTurnEnd(run: AgentRun, maxMs: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iterator = run.events[Symbol.asyncIterator]();
  const deadline = Date.now() + maxMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { break; }
    const result = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) => {
        setTimeout(() => { resolve({ done: true, value: undefined }); }, remaining);
      }),
    ]);
    if (result.done || !result.value) { break; }
    events.push(result.value);
    if (result.value.kind === 'turn-end') { break; }
  }
  return events;
}

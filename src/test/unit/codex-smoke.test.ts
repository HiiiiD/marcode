import * as assert from 'assert';
import { execFileSync, spawn as spawnChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppServer, type Duplex } from '../../providers/codex/app-server';
import { CodexProvider } from '../../providers/codex/codex-provider';
import type { AgentEvent, AgentRun } from '../../providers/types';
import type { RateLimitsReadResponse } from '../../providers/codex/wire';

/**
 * Opt-in tests against a real `codex` binary — a smoke test and the
 * protocol-skew check described in `src/providers/codex/wire.ts`'s header.
 *
 * These need a real binary and a signed-in account, so the whole suite
 * skips (never fails) when either is absent — a contributor without Codex
 * must still get a green `yarn test:unit`. `codexAvailable()` is a cheap
 * `codex --version` probe, not a spawn-and-wait, so the skip decision costs
 * nothing when Codex is absent.
 */

function codexAvailable(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const CODEX_SRC_DIR = path.join(__dirname, '..', '..', 'providers', 'codex');

/**
 * Every JSON-RPC method name our code sends, read out of the source rather
 * than duplicated by hand — a second, hardcoded list would just be a third
 * thing to keep in sync, and the whole point of this test is to catch a
 * drift, not create one. Matches `server.request('method', ...)` and
 * `server.request<T>('method', ...)`, including the multi-line call in
 * `codex-run.ts`'s `thread/resume` branch.
 */
function collectSentMethods(): string[] {
  const files = ['codex-provider.ts', 'codex-run.ts'];
  const pattern = /\.request(?:<[^()]*>)?\(\s*(?:\r?\n\s*)?'([^']+)'/g;
  const methods = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(path.join(CODEX_SRC_DIR, file), 'utf8');
    for (const match of text.matchAll(pattern)) { methods.add(match[1]); }
  }
  return [...methods];
}

/** Every method name the generated `ClientRequest.ts` union declares. */
function collectGeneratedMethods(clientRequestSource: string): Set<string> {
  const pattern = /"method":\s*"([^"]+)"/g;
  return new Set([...clientRequestSource.matchAll(pattern)].map((m) => m[1]));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Real, child-process-backed spawn — same shape as `codex-provider.ts`'s `defaultSpawn`. */
function spawnCodex(): Duplex {
  const child = spawnChildProcess('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    kill: () => { child.kill(); },
  };
}

/** Races a promise against a timeout so a hung real process can never block cleanup. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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
 * Drains `run.events` until a `turn-end` arrives or `maxMs` elapses,
 * whichever comes first. A plain `for await` would hang the test (and the
 * child process) forever if the real turn never ends; racing each `next()`
 * against a deadline means a stuck server yields an empty/partial event
 * list instead of an unkillable test.
 */
async function collectUntilTurnEnd(run: AgentRun, maxMs: number): Promise<AgentEvent[]> {
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

suite('codex smoke (opt-in)', function () {
  this.timeout(60_000);
  // TDD interface: `suiteSetup`, not BDD's `before` — the latter is not a
  // global under `--ui tdd` and would throw a ReferenceError at load time.
  suiteSetup(function () { if (!codexAvailable()) { this.skip(); } });

  test('every method name we send still exists in the generated protocol', function () {
    // The closest thing to the version negotiation the handshake does not
    // offer: InitializeResponse carries no protocol version, so a renamed
    // method would otherwise surface as a runtime failure in a user's panel.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bindings-'));
    try {
      try {
        execFileSync('codex', ['app-server', 'generate-ts', '--out', tmp], { stdio: 'ignore' });
      } catch {
        // `generate-ts` is experimental — skip rather than fail if this
        // install's CLI doesn't have it.
        this.skip();
        return;
      }
      const clientRequestPath = path.join(tmp, 'ClientRequest.ts');
      if (!fs.existsSync(clientRequestPath)) { this.skip(); return; }
      const generatedMethods = collectGeneratedMethods(fs.readFileSync(clientRequestPath, 'utf8'));

      const ourMethods = collectSentMethods();
      assert.ok(
        ourMethods.length > 0,
        'expected to find at least one server.request(...) call under src/providers/codex',
      );
      for (const method of ourMethods) {
        assert.ok(
          generatedMethods.has(method),
          `method "${method}" sent from src/providers/codex is missing from the generated `
            + 'ClientRequest.ts — codex likely renamed it upstream',
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a plan-mode turn produces a session, text and a turn end', async function () {
    this.timeout(90_000);
    const provider = new CodexProvider({});
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-smoke-'));
    // Plan mode is approvalPolicy 'never' + sandbox 'read-only' (map-settings.ts)
    // — this run cannot write to the repo it runs in, and it is spawned
    // against a scratch cwd on top of that as a second line of defense.
    const run = provider.start({ cwd, permissionMode: 'plan' });
    try {
      run.send('Reply with exactly the word hi and nothing else.');
      const events = await collectUntilTurnEnd(run, 60_000);
      const kinds = events.map((e) => e.kind);

      assert.ok(kinds.includes('session'), `expected a session event; got [${kinds.join(', ')}]`);
      assert.ok(kinds.includes('text'), `expected a text event; got [${kinds.join(', ')}]`);
      const turnEnd = events.find((e): e is Extract<AgentEvent, { kind: 'turn-end' }> => e.kind === 'turn-end');
      assert.ok(turnEnd, `expected a turn-end event; got [${kinds.join(', ')}]`);
      assert.strictEqual(turnEnd.reason, 'done');
    } finally {
      await run.dispose();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('resetsAt is still epoch seconds', async function () {
    this.timeout(30_000);
    // Pins the measurement map-usage.ts depends on, so a CLI upgrade that
    // switched to milliseconds fails here rather than rendering a countdown
    // 50000 years out. Guard, not discovery: the unit was measured on
    // 0.147.0 (1787337648 against a wall clock of 1786736436s) and is epoch
    // seconds.
    const server = new AppServer(spawnCodex());
    try {
      await withTimeout(server.request('initialize', {
        clientInfo: { name: 'hiiiid-code-smoke-test', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
      }), 20_000, 'initialize');

      const response = await withTimeout(
        server.request<RateLimitsReadResponse>('account/rateLimits/read', {}),
        20_000,
        'account/rateLimits/read',
      );
      const raw = response.rateLimits.primary?.resetsAt ?? response.rateLimits.secondary?.resetsAt;
      assert.ok(raw !== null && raw !== undefined, 'expected a resetsAt value from account/rateLimits/read');

      const nowSeconds = Date.now() / 1000;
      const oneYearSeconds = 365 * 24 * 60 * 60;
      assert.ok(
        Math.abs((raw as number) - nowSeconds) < oneYearSeconds,
        `resetsAt (${raw}) is not within a year of Date.now()/1000 (${nowSeconds}) — `
          + 'codex may have switched resetsAt to a different unit',
      );
    } catch (err) {
      assert.fail(`account/rateLimits/read probe failed: ${errorMessage(err)}`);
    } finally {
      server.dispose();
    }
  });
});

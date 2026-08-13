// See map-events.ts for the full record of the SDK surface read from
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts. Notes specific to
// this file:
//
// - `@anthropic-ai/claude-agent-sdk` ships `"type": "module"` (ESM-only,
//   `main: "sdk.mjs"`). This extension host bundle is CJS (esbuild
//   `format: 'cjs'`), so the runtime `query` function must be reached via a
//   dynamic `import()` — a static `import { query } from '...'` fails
//   TypeScript compilation with TS1479 ("referenced file is an ECMAScript
//   module and cannot be imported with 'require'"). Types are imported
//   separately with `import type ... with { 'resolution-mode': 'import' }`,
//   which resolves the `.d.ts` without requiring a CJS/ESM interop shim.
// - `canUseTool`'s real signature is `(toolName, input, options) => Promise<
//   PermissionResult | null>`, where `options.toolUseID` is the id — not the
//   single-object `(request: { tool_name, name, input }) => ...` shape the
//   plan's pseudocode assumed. Fixed here.
//
// LAZY START (this round): `start()` used to call `query()` immediately —
// i.e. inside the `AgentSession` constructor, before any message exists —
// which spawns a `claude` CLI subprocess for every session the moment it is
// created, whether or not the user ever sends anything (flagged by an
// earlier review as "opening N sessions spawns N idle CLI processes"). The
// query is now constructed lazily, on the first `send()`, via `ensureStarted()`.
// This has a second, load-bearing consequence: `Options` — in particular
// `permissionMode` and the conditional `allowDangerouslySkipPermissions`
// (see below) — are built from `pendingMode`/`pendingEffort`, mutable local
// state that `setPermissionMode`/`setEffort` update directly whenever the
// query has not been constructed yet, rather than from the `StartOptions`
// snapshot `start()` was originally called with. A `setPermissionMode('bypass')`
// call before the first `send()` is therefore simply what the session
// starts with, flag included — no restart, no dispose-and-respawn hack, no
// guard on transcript items needed anywhere in this file or in
// `AgentSession`. `PERMISSION_MODE` remains the only place a `PermissionMode`
// is translated to the SDK's spelling.
//
// After the query is constructed (`queryRef` is set), `setPermissionMode`
// and `setEffort` switch to the live seams described below
// (`Query.setPermissionMode` / `Query.applyFlagSettings`) instead of
// mutating the now-irrelevant pending values.
//
// - `setEffort` uses `Query.applyFlagSettings({ effortLevel })`, a genuine
//   live setter (see map-events.ts header for why this is stronger than the
//   plan's "store and apply on next send" fallback). If it fails (e.g. the
//   session isn't in streaming mode), the failure is swallowed rather than
//   surfaced as a turn-end error — a rejected effort change is not a failed
//   agent turn, and AgentSession.setEffort() only awaits nothing (setEffort
//   is fire-and-forget by interface), so there is no caller to report to.
// - `setPermissionMode` uses `Query.setPermissionMode(mode)` (sdk.d.ts:2377,
//   "Only available in streaming input mode" — which is the mode this
//   provider always uses), so a mode switch mutates the *running* session,
//   not just recorded UI state. `Query.setPermissionMode` returns
//   `Promise<void>`, and the `AgentRun`/`Query` methods it's built on are
//   themselves capable of throwing synchronously before ever returning a
//   promise (e.g. if the underlying transport is already torn down) — both
//   `setEffort` and `setPermissionMode` wrap the call in `try/catch` *and*
//   attach a `.catch()` to the returned promise, so neither a synchronous
//   throw nor an async rejection can escape a `void`-returning `AgentRun`
//   method.
// - `allowDangerouslySkipPermissions` must be `true` exactly when, and only
//   when, the *effective mode at construction time* is 'bypass' — strict
//   equality, key absent (not `false`) for every other mode. This was
//   briefly set unconditionally in an earlier pass; that reasoning ("the
//   human has explicitly opted into bypass for every session") did not
//   come from the human — it was an inference in the instruction that
//   produced it, and the human decided against it on review. The accurate,
//   verifiable statement is narrower: bypass is an opt-in capability
//   granted per session at construction, because the SDK reads this flag
//   only once, when `query()` is constructed
//   (`Options.allowDangerouslySkipPermissions`) — unlike `permissionMode`
//   itself, which has a live setter. Because construction is now lazy (see
//   above), "at construction time" means "at first `send()`", not "when
//   `start()` was called" — so a mode chosen any time before the first
//   message is still exactly what the session starts with.
// - `Options.stderr` is deliberately left unset — forwarding raw CLI stderr
//   into a `console.error` (as the plan's pseudocode did) risks leaking
//   secrets. CORRECTION to an earlier pass of this comment: leaving the
//   option unset does NOT keep stderr out of the picture. The installed
//   SDK's `ProcessTransport` accumulates a `stderrTail` unconditionally (not
//   gated on `Options.stderr`) and appends `. stderr: <tail>` to the `Error`
//   it throws on a nonzero exit or signal kill — which reaches the query
//   pump's catch below regardless of whether we ever set the callback. The
//   SDK pre-redacts a fixed table of well-known token shapes before
//   capturing that tail, but anything outside the table passes through
//   verbatim. See redact.ts for the mitigation: every message built by
//   `errorMessage()` below is run through `redactSecrets()` before it
//   becomes an `AgentEvent` (and therefore before it can reach a persisted
//   transcript item).
// - `Options.includePartialMessages` is left unset (defaults to false/off).
//   Enabling it emits fine-grained `SDKPartialAssistantMessage` stream
//   events (`type: 'stream_event'`) requiring a much wider set of shapes to
//   map for no functional gain here: full `assistant` messages already
//   arrive per content block, which is enough for `AgentSession` to render
//   incremental text/thinking/tool-start items.
//
// The two live setters below (`setEffort`, `setPermissionMode`) swallow their
// failures: a rejected effort or mode change is not a failed agent turn, so it
// is not surfaced to the user as one. Swallowing silently, though, once cost a
// full debugging round — a live report of "changing effort does nothing" was
// indistinguishable from the outside between "the call was never made", "the
// call was made and rejected", and "the call resolved but had no effect". The
// failure paths therefore log; the success paths do not, so normal operation
// stays quiet. That root cause turned out to be in the webview reducer, not
// here: both SDK calls resolve.
//
// OPEN QUESTION, not acted on here: the installed `.d.ts` shows
// `Settings.permissions.defaultMode` accepting `'bypassPermissions'`,
// `Query.applyFlagSettings` taking arbitrary `Settings` keys, and a
// `permissions.disableBypassPermissionsMode` opt-out — suggesting bypass may be
// reachable live, via `applyFlagSettings`, without ever touching
// `Options.allowDangerouslySkipPermissions`. Unverified. The lazy-start design
// in this file is correct either way, but it may mean the "only at
// construction" constraint documented here is narrower than the SDK requires.
import type {
  CanUseTool, Options, PermissionMode as SdkPermissionMode, Query, SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { mapEvent } from './map-events';
import { redactSecrets } from './redact';
import type {
  AgentEvent, AgentProvider, AgentRun, EffortLevel, ModelInfo, PermissionMode,
  StartOptions, ToolDecision,
} from '../types';

const MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5', displayName: 'Opus 5',
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
  },
  {
    id: 'claude-sonnet-5', displayName: 'Sonnet 5',
    effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
  },
  // `claude-haiku-4-5` is NOT a value the CLI knows: it silently becomes a
  // "Custom model" passthrough. `haiku` is the CLI's own alias, and resolves to
  // claude-haiku-4-5-20251001. Verified against the SDK's initializationResult.
  { id: 'haiku', displayName: 'Haiku 4.5' },
];

/**
 * Ours -> the SDK's real `PermissionMode` union (verified against the
 * installed .d.ts — see map-events.ts). Every one of our members has a real
 * counterpart; only 'bypass' needs renaming.
 */
const PERMISSION_MODE: Record<PermissionMode, SdkPermissionMode> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  dontAsk: 'dontAsk',
  bypass: 'bypassPermissions',
};

/** The shape of the SDK's `query()` export, isolated so tests can inject a fake. */
type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/**
 * Real, dynamic-import-backed query loader — the production default. Kept
 * as its own function (rather than inlined into `start()`) so a test can
 * construct `new ClaudeProvider(fakeLoadQuery)` and observe exactly when,
 * and with what `Options`, a query gets constructed, without contorting the
 * lazy-start logic itself or reaching into a real CLI subprocess.
 */
async function loadQuery(): Promise<QueryFn> {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  return mod.query;
}

class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const next = this.queue.shift();
        if (next !== undefined) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined as never, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly displayName = 'Claude';

  constructor(private readonly loadQueryFn: () => Promise<QueryFn> = loadQuery) {}

  listModels(): ModelInfo[] { return MODELS; }

  start(opts: StartOptions): AgentRun {
    const events = new Channel<AgentEvent>();
    const prompts = new Channel<SDKUserMessage>();
    const approvals = new Map<string, (decision: ToolDecision) => void>();
    let disposed = false;
    let started = false;
    let queryRef: Query | undefined;
    // Effective mode/effort for a query not yet constructed. Read by
    // ensureStarted() -> buildOptions() at the moment the query actually
    // gets built (first send()); mutated directly by setPermissionMode()/
    // setEffort() below whenever that hasn't happened yet.
    let pendingMode: PermissionMode = opts.permissionMode;
    let pendingEffort = opts.effort;
    let pump: Promise<void> = Promise.resolve();

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const id = options.toolUseID;
      events.push({ kind: 'permission', id, name: toolName, input });
      const decision = await new Promise<ToolDecision>((resolve) => {
        approvals.set(id, resolve);
      });
      return decision.allow
        ? { behavior: 'allow', updatedInput: decision.updatedInput as Record<string, unknown> | undefined }
        : { behavior: 'deny', message: decision.reason ?? 'Denied by user' };
    };

    function buildOptions(): Options {
      const isBypassMode = pendingMode === 'bypass';
      return {
        cwd: opts.cwd,
        model: opts.model,
        resume: opts.resumeToken,
        permissionMode: PERMISSION_MODE[pendingMode],
        canUseTool,
        ...(pendingEffort !== undefined ? { effort: pendingEffort } : {}),
        ...(isBypassMode ? { allowDangerouslySkipPermissions: true } : {}),
      };
    }

    // Constructs the SDK query exactly once, on the first send(). Never
    // called from interrupt()/setEffort()/setPermissionMode()/dispose() —
    // none of those should spawn a subprocess that was never asked to run.
    const ensureStarted = (): void => {
      if (started || disposed) { return; }
      started = true;
      pump = (async () => {
        try {
          const query = await this.loadQueryFn();
          const constructedOptions = buildOptions();
          const session = query({ prompt: prompts, options: constructedOptions });
          queryRef = session;
          for await (const msg of session) {
            for (const event of mapEvent(msg)) { events.push(event); }
          }
        } catch (err) {
          events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
        } finally {
          events.close();
        }
      })();
    };

    return {
      events,
      send: (text: string) => {
        ensureStarted();
        prompts.push({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
        });
      },
      respondToTool: (id, decision) => {
        const resolve = approvals.get(id);
        if (resolve) { approvals.delete(id); resolve(decision); }
      },
      setEffort: (next: EffortLevel) => {
        pendingEffort = next;
        if (!queryRef) {
          return; // not yet constructed: pendingEffort above is picked up at construction.
        }
        try {
          // Best-effort: an effort change that the SDK rejects (e.g. the model
          // doesn't support it) is not a failed agent turn, so it is not
          // surfaced as a turn-end error — logged only. See the header comment.
          queryRef.applyFlagSettings({ effortLevel: next }).catch((reason: unknown) => {
            console.warn('[hiiiid-code] applyFlagSettings rejected', 'effort=', next, 'reason=', errorMessage(reason));
          });
        } catch (err) {
          // A synchronous throw (e.g. the query is already torn down) is
          // exactly as non-fatal as an async rejection above — same reason.
          console.warn('[hiiiid-code] applyFlagSettings threw', 'effort=', next, 'error=', errorMessage(err));
        }
      },
      setPermissionMode: (mode: PermissionMode) => {
        pendingMode = mode;
        if (!queryRef) {
          return; // not yet constructed: pendingMode above is picked up at construction.
        }
        try {
          // Best-effort: a mode change the SDK rejects is not a failed agent
          // turn, so it is not surfaced as a turn-end error — same reasoning as
          // setEffort above.
          queryRef.setPermissionMode(PERMISSION_MODE[mode]).catch((reason: unknown) => {
            console.warn('[hiiiid-code] setPermissionMode rejected', 'mode=', mode, 'reason=', errorMessage(reason));
          });
        } catch (err) {
          // Synchronous throw, same treatment as the async rejection above.
          console.warn('[hiiiid-code] setPermissionMode threw', 'mode=', mode, 'error=', errorMessage(err));
        }
      },
      interrupt: async () => {
        if (!queryRef) { return; } // nothing has ever run: a no-op, not a failure.
        try {
          await queryRef.interrupt();
        } catch (err) {
          events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
        }
      },
      dispose: async () => {
        if (disposed) { return; }
        disposed = true;
        for (const [, resolve] of approvals) {
          resolve({ allow: false, reason: 'Session closed' });
        }
        approvals.clear();
        prompts.close();
        try {
          queryRef?.close();
        } catch {
          // Best-effort: the process is being torn down regardless.
        }
        // If send() was never called, nothing ever closes `events` (the
        // query pump's own `finally` never runs) — AgentSession.dispose()
        // awaits this run's `events` draining to `done` via its own pump,
        // so closing here unconditionally is required to avoid hanging it
        // forever on a channel nothing else will ever close. Idempotent
        // with the pump's own close() when a query WAS constructed.
        events.close();
        await pump;
      },
    };
  }
}

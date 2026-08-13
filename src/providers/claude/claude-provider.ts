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
//   `setEffort` and `setPermissionMode` below wrap the call in `try/catch`
//   *and* attach a `.catch()` to the returned promise, so neither a
//   synchronous throw nor an async rejection can escape a `void`-returning
//   `AgentRun` method. (An earlier pass of this file only had the `.catch()`
//   on `setEffort`'s `applyFlagSettings` call, missing the synchronous case
//   — fixed here on both methods.)
// - `Options.stderr` is deliberately left unset — forwarding raw CLI stderr
//   into a `console.error` (as the plan's pseudocode did) risks leaking
//   secrets. CORRECTION to an earlier pass of this comment: leaving the
//   option unset does NOT keep stderr out of the picture. The installed
//   SDK's `ProcessTransport` accumulates a `stderrTail` unconditionally (not
//   gated on `Options.stderr`) and appends `. stderr: <tail>` to the `Error`
//   it throws on a nonzero exit or signal kill — which reaches `pump()`'s
//   catch below regardless of whether we ever set the callback. The SDK
//   pre-redacts a fixed table of well-known token shapes before capturing
//   that tail, but anything outside the table passes through verbatim. See
//   redact.ts for the mitigation: every message built by `errorMessage()`
//   below is run through `redactSecrets()` before it becomes an `AgentEvent`
//   (and therefore before it can reach a persisted transcript item).
// - `Options.includePartialMessages` is left unset (defaults to false/off).
//   Enabling it emits fine-grained `SDKPartialAssistantMessage` stream
//   events (`type: 'stream_event'`) requiring a much wider set of shapes to
//   map for no functional gain here: full `assistant` messages already
//   arrive per content block, which is enough for `AgentSession` to render
//   incremental text/thinking/tool-start items.
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
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
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

  listModels(): ModelInfo[] { return MODELS; }

  start(opts: StartOptions): AgentRun {
    const events = new Channel<AgentEvent>();
    const prompts = new Channel<SDKUserMessage>();
    const approvals = new Map<string, (decision: ToolDecision) => void>();
    let effort = opts.effort;
    let disposed = false;

    let queryRef: Query | undefined;

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

    // `allowDangerouslySkipPermissions` is now set unconditionally, on every
    // session regardless of its starting mode — CORRECTING an earlier pass
    // that set it only when `opts.permissionMode === 'bypass'` at session
    // start. That was wrong once `setPermissionMode` became a live,
    // mid-session seam (see below): the flag is a *capability gate* ("this
    // application may bypass permissions at all"), while `permissionMode` —
    // set once here and changeable afterward via `Query.setPermissionMode`
    // — is what actually governs behavior at any given moment. Leaving the
    // flag conditional on the start mode meant `setPermissionMode('bypassPermissions')`
    // would fail for any session that didn't happen to start in bypass, so
    // the header badge and destructive styling (session-header.tsx,
    // composer.tsx) could show "bypassing" while the live agent silently
    // kept enforcing its old mode — the exact lie those two UI layers exist
    // to prevent. The human has explicitly opted into bypass being
    // available for every session; `PERMISSION_MODE` below remains the only
    // place a `PermissionMode` is translated to the SDK's spelling.
    const options: Options = {
      cwd: opts.cwd,
      model: opts.model,
      resume: opts.resumeToken,
      permissionMode: PERMISSION_MODE[opts.permissionMode],
      canUseTool,
      allowDangerouslySkipPermissions: true,
      ...(effort !== undefined ? { effort } : {}),
    };

    const pump = (async () => {
      try {
        const { query } = await import('@anthropic-ai/claude-agent-sdk');
        const session = query({ prompt: prompts, options });
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

    return {
      events,
      send: (text: string) => {
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
        effort = next;
        if (!queryRef) { return; }
        try {
          queryRef.applyFlagSettings({ effortLevel: next }).catch(() => {
            // Best-effort: an effort change that the SDK rejects (e.g. the
            // model doesn't support it) is not a failed agent turn, so it is
            // not surfaced as a turn-end error — see the header comment.
          });
        } catch {
          // A synchronous throw (e.g. the query is already torn down) is
          // exactly as non-fatal as an async rejection above — same reason.
        }
      },
      setPermissionMode: (mode: PermissionMode) => {
        if (!queryRef) { return; }
        try {
          queryRef.setPermissionMode(PERMISSION_MODE[mode]).catch(() => {
            // Best-effort: a mode change the SDK rejects is not a failed
            // agent turn, so it is not surfaced as a turn-end error — same
            // reasoning as setEffort above.
          });
        } catch {
          // Synchronous throw, same treatment as the async rejection above.
        }
      },
      interrupt: async () => {
        try {
          await queryRef?.interrupt();
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
        await pump;
      },
    };
  }
}

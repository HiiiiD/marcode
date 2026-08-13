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
// - `Options.stderr` is deliberately left unset. Forwarding raw CLI stderr
//   into a `console.error` (as the plan's pseudocode did) risks leaking
//   secrets: stderr can echo failed subprocess command lines, and this
//   task's brief explicitly requires never logging or echoing credentials.
//   Thrown errors and `result` messages already carry a legible, structured
//   error surface (see map-events.ts) without touching stderr.
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
  return err instanceof Error ? err.message : String(err);
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

    const options: Options = {
      cwd: opts.cwd,
      model: opts.model,
      resume: opts.resumeToken,
      permissionMode: PERMISSION_MODE[opts.permissionMode],
      canUseTool,
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
        queryRef.applyFlagSettings({ effortLevel: next }).catch(() => {
          // Best-effort: an effort change that the SDK rejects (e.g. the
          // model doesn't support it) is not a failed agent turn, so it is
          // not surfaced as a turn-end error — see the header comment.
        });
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

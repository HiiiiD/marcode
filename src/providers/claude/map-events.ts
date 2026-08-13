// SDK surface verified against node_modules/@anthropic-ai/claude-agent-sdk
// (@anthropic-ai/claude-agent-sdk@0.3.228) on 2026-08-13, by reading
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts directly (and the
// @anthropic-ai/sdk beta message types it imports for content-block shapes).
// Update this comment whenever the dependency is upgraded.
//
// `Options` fields we use:
//   cwd?: string
//   model?: string
//   resume?: string
//   permissionMode?: PermissionMode
//   canUseTool?: CanUseTool
//   includePartialMessages?: boolean   (left unset/false — see claude-provider.ts)
//   stderr?: (data: string) => void    (left unset — see claude-provider.ts)
//
// `PermissionMode` (the real union, verbatim from the .d.ts):
//   'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
//   Every member of our own union — 'default' | 'acceptEdits' | 'plan' |
//   'dontAsk' | 'bypass' — has a real counterpart ('bypass' -> 'bypassPermissions',
//   the rest are identical spellings). Nothing to drop from
//   src/providers/types.ts, PERMISSION_MODE, or composer.tsx: the plan's fear
//   that 'acceptEdits' might not exist was unfounded for this SDK version.
//   The SDK's extra 'auto' member (model-classifier permission mode) has no
//   equivalent in our UI and is simply never produced by PERMISSION_MODE.
//
// `SDKMessage` is a large discriminated union (35+ variants: system/*,
// assistant, user, result/*, task/*, hook/*, etc). We only map the variants
// that matter to the UI and defensively drop everything else:
//   - `{ type: 'system', subtype: 'init', session_id, ... }` — session id.
//     (Other `type: 'system'` subtypes — 'status', 'task_notification',
//     'session_state_changed', etc. — also carry a `session_id`, so gating on
//     `subtype === 'init'` specifically, rather than "any system message with
//     a session_id", avoids emitting a spurious `session` event on every
//     later system heartbeat. The plan's pseudocode did not gate on subtype.)
//   - `{ type: 'assistant', message: BetaMessage, ... }` — content blocks are
//     `BetaContentBlock`. We map `BetaTextBlock { type: 'text', text }` and
//     `BetaToolUseBlock { type: 'tool_use', id, name, input }`.
//     `BetaThinkingBlock` is `{ type: 'thinking', thinking: string, signature }`
//     — note the text lives in `.thinking`, NOT `.text`. The plan's pseudocode
//     read `block.text` for thinking blocks too, which would have silently
//     dropped every thinking delta (the field is always undefined on a
//     thinking block); fixed here.
//   - `{ type: 'user', message: { content: [...] }, ... }` — the CLI echoes
//     tool results back as a `user` message. Blocks are `BetaToolResultBlockParam
//     { type: 'tool_result', tool_use_id, content, is_error? }`.
//   - `{ type: 'result', subtype, ... }` — `SDKResultMessage = SDKResultSuccess
//     | SDKResultError`. `SDKResultSuccess` (`subtype: 'success'`) carries
//     `usage: NonNullableUsage` (`input_tokens`/`output_tokens`, verified
//     against `BetaUsage`). `SDKResultError` (`subtype:
//     'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' |
//     'error_max_structured_output_retries'`) DOES carry free-text error
//     detail — CORRECTING an earlier pass of this comment (and the task-14
//     report) that claimed otherwise: `errors: string[]` (sdk.d.ts:4461) and
//     `terminal_reason?: TerminalReason` (sdk.d.ts:4462, values including
//     `'api_error' | 'model_error' | 'prompt_too_long' | 'budget_exhausted' |
//     'aborted_streaming' | 'aborted_tools' | ...`, full union at
//     sdk.d.ts:7254) are both real, typed fields. We prefer `errors.join('; ')`
//     when non-empty, then `terminal_reason`, then `stop_reason`, then
//     `subtype`, so an auth failure or an over-length prompt surfaces its
//     actual cause instead of the bare subtype string.
//   - `terminal_reason` values `'aborted_streaming'` and `'aborted_tools'` are
//     how the SDK reports a user-initiated `Query.interrupt()` — the result
//     still arrives with `subtype !== 'success'`, so without special-casing
//     these two values every Stop click would surface as a red `turn-end
//     reason: 'error'` transcript item instead of `reason: 'interrupted'`
//     (the reason `FakeProvider` and the `AgentEvent` union establish for a
//     user-initiated stop). Mapped to `{ kind: 'turn-end', reason:
//     'interrupted' }` here, ahead of the generic error path.
//
// `SDKUserMessage` (what we construct for `send`): `{ type: 'user', message:
// MessageParam, parent_tool_use_id: string | null, ... }` where `MessageParam
// = { role: 'user' | 'assistant' | 'system', content: string | ContentBlockParam[] }`.
// `session_id` on `SDKUserMessage` is optional and is not needed when the
// resumed session id is already passed via `Options.resume` at `query()`
// construction, so we omit it rather than sending an empty string.
//
// `Query` (returned by `query()`): extends `AsyncGenerator<SDKMessage, void>`
// and exposes `interrupt(): Promise<SDKControlInterruptResponse | undefined>`
// and `setPermissionMode(mode): Promise<void>`. There is no `setEffort`
// method. Effort is only settable as a one-shot `Options.effort` at `query()`
// construction, OR live mid-session via `Query.applyFlagSettings({
// effortLevel })` (its type explicitly widens to accept the full
// `EffortLevel` union, including `'max'`, for that one key). We use the
// latter in claude-provider.ts, which is a stronger guarantee than the
// plan's fallback ("store the value, apply on next send") — the plan
// assumed no live setter existed at all, but `applyFlagSettings` is one.
import type { AgentEvent } from '../types';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocks(msg: unknown): Block[] {
  const message = (msg as { message?: { content?: unknown } }).message;
  return Array.isArray(message?.content) ? (message.content as Block[]) : [];
}

export function mapEvent(msg: unknown): AgentEvent[] {
  const type = (msg as { type?: string }).type;

  if (type === 'system') {
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype !== 'init') { return []; }
    const sessionId = (msg as { session_id?: string }).session_id;
    return sessionId ? [{ kind: 'session', resumeToken: sessionId }] : [];
  }

  if (type === 'assistant') {
    const out: AgentEvent[] = [];
    for (const block of blocks(msg)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ kind: 'text', delta: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        out.push({ kind: 'thinking', delta: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({
          kind: 'tool-start', id: block.id, name: block.name, input: block.input,
        });
      }
    }
    return out;
  }

  if (type === 'user') {
    const out: AgentEvent[] = [];
    for (const block of blocks(msg)) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        out.push({
          kind: 'tool-end',
          id: block.tool_use_id,
          ok: block.is_error !== true,
          output: block.content,
        });
      }
    }
    return out;
  }

  if (type === 'result') {
    const out: AgentEvent[] = [];
    const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    if (usage) {
      out.push({
        kind: 'usage',
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      });
    }
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype === 'success') {
      out.push({ kind: 'turn-end', reason: 'done' });
      return out;
    }

    const terminalReason = (msg as { terminal_reason?: string }).terminal_reason;
    if (terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools') {
      out.push({ kind: 'turn-end', reason: 'interrupted' });
      return out;
    }

    const errors = (msg as { errors?: unknown }).errors;
    const errorList = Array.isArray(errors)
      ? errors.filter((e): e is string => typeof e === 'string' && e.length > 0)
      : [];
    const stopReason = (msg as { stop_reason?: string | null }).stop_reason;
    const detail = errorList.length > 0
      ? errorList.join('; ')
      : (terminalReason || stopReason || subtype);
    out.push({ kind: 'turn-end', reason: 'error', error: detail || 'Agent error' });
    return out;
  }

  return [];
}

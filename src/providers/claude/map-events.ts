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
//     'error_max_structured_output_retries'`) has NO free-text `error` field
//     — the plan's pseudocode read `msg.error`, which does not exist on the
//     real type and would always be `undefined`. We build the error string
//     from `subtype` (and `stop_reason` when present) instead.
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
    } else {
      const stopReason = (msg as { stop_reason?: string | null }).stop_reason;
      const detail = [subtype, stopReason].filter((v): v is string => Boolean(v)).join(': ');
      out.push({ kind: 'turn-end', reason: 'error', error: detail || 'Agent error' });
    }
    return out;
  }

  return [];
}

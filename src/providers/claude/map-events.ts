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
//   Every member of our own union — 'default' | 'acceptEdits' | 'auto' | 'plan' |
//   'dontAsk' | 'bypass' — has a real counterpart ('bypass' -> 'bypassPermissions',
//   the rest are identical spellings), and our union now covers the SDK's in
//   full. Nothing to drop from src/providers/types.ts, PERMISSION_MODE, or
//   composer.tsx: the plan's fear that 'acceptEdits' might not exist was
//   unfounded for this SDK version.
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
// and `setPermissionMode(mode): Promise<void>` — the latter is a genuine
// live, mid-session mode setter and is used as such in claude-provider.ts.
// There is no `setEffort` method. Effort is only settable as a one-shot
// `Options.effort` at `query()` construction, OR live mid-session via
// `Query.applyFlagSettings({ effortLevel })` (its type explicitly widens to
// accept the full `EffortLevel` union, including `'max'`, for that one
// key). We use the latter in claude-provider.ts, which is a stronger
// guarantee than the plan's fallback ("store the value, apply on next
// send") — the plan assumed no live setter existed at all, but
// `applyFlagSettings` is one.
//
// The `errors[]` text mapped above reaches a persisted transcript item via
// `AgentSession.fail()` exactly like the thrown-`Error` text
// claude-provider.ts's `errorMessage()` redacts — so it goes through the
// same `redactSecrets()` pass before becoming a `turn-end` event.
// `redactSecrets` is pure and does no I/O, so calling it here does not
// violate this file's purity constraint.
//
//   - Subagent correlation: `parent_tool_use_id: string | null` is present on
//     `SDKAssistantMessage` (sdk.d.ts:3022) and on the `user` messages that
//     carry tool results. Non-null means the message came from a subagent,
//     and its value is the tool_use id of the `Task` call that spawned it —
//     which is exactly the id our own `tool-start` for that Task already
//     carries, so no extra correlation event is needed.
//   - `Options.forwardSubagentText` (sdk.d.ts:1662) defaults to false, and
//     at that default "only tool_use/tool_result blocks from subagents are
//     emitted". That default IS the mechanism behind our tool-activity-only
//     subagent cards; claude-provider.ts must never set it to true. The
//     text/thinking drop below is a belt-and-braces assertion on top.
//   - `SDKSystemMessage` (subtype 'init') carries `mcp_servers: { name:
//     string; status: string }[]` (sdk.d.ts:4610) — name and status only.
//     `status` is typed as a bare string, hence toServerState()'s fallback.
//     The richer per-server shape (error, tools[]) comes from
//     `Query.mcpServerStatus()` (sdk.d.ts:2500), pulled in claude-provider.ts.
//   - `canUseTool`'s options give `agentID` (the subagent instance id), NOT
//     the spawning Task's tool_use id, so a permission cannot be nested from
//     the SDK payload alone. AgentSession derives it instead: the permission
//     id IS the tool_use id of the call being approved, so it resolves
//     through the same child map that tool-start populated.
//   - `{ type: 'rate_limit_event', rate_limit_info: SDKRateLimitInfo, ... }`
//     (sdk.d.ts:4408) — pushed by the CLI whenever plan/account usage moves,
//     unprompted, including once shortly after connect. It carries no
//     utilization percentage at steady state (only `status` is required,
//     sdk.d.ts:4421), so it is treated as a bare signal — `{ kind:
//     'usage-stale' }` — rather than data: it tells the host a pull is
//     worth making, and `AgentRun.usageWindows()` (backed by the structured
//     usage response, mapped through `toUsageWindows` in map-context.ts) is
//     what actually answers with numbers.
import type { AgentEvent, McpServerStatus } from '../types';
import { toInvocables } from './map-commands';
import { toToolCall, toToolOutput } from './map-tools';
import { redactSecrets } from './redact';

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

const SERVER_STATES = new Set<McpServerStatus['state']>([
  'pending', 'connected', 'failed', 'needs-auth', 'disabled',
]);

/**
 * `SDKSystemMessage.mcp_servers` types `status` as a bare `string`
 * (sdk.d.ts:4610), so an unknown value is possible on any SDK bump. Degrade
 * to 'pending' rather than dropping the server — a server missing from the
 * strip reads as "not configured", which is a worse lie than "still
 * starting".
 */
function toServerState(raw: unknown): McpServerStatus['state'] {
  return SERVER_STATES.has(raw as McpServerStatus['state'])
    ? (raw as McpServerStatus['state'])
    : 'pending';
}

function parentIdOf(msg: unknown): string | undefined {
  const raw = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export function mapEvent(msg: unknown): AgentEvent[] {
  const type = (msg as { type?: string }).type;

  if (type === 'system') {
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype === 'commands_changed') {
      // A full replacement list, which is exactly our snapshot contract —
      // no diffing, and an empty array is a legitimate "none available".
      return [{
        kind: 'invocables',
        entries: toInvocables((msg as { commands?: unknown }).commands),
      }];
    }
    if (subtype !== 'init') { return []; }
    const out: AgentEvent[] = [];
    const sessionId = (msg as { session_id?: string }).session_id;
    if (sessionId) { out.push({ kind: 'session', resumeToken: sessionId }); }

    const servers = (msg as { mcp_servers?: unknown }).mcp_servers;
    if (Array.isArray(servers) && servers.length > 0) {
      out.push({
        kind: 'mcp-servers',
        servers: servers
          .filter((s): s is { name: string; status?: unknown } =>
            typeof (s as { name?: unknown }).name === 'string')
          .map((s) => ({ name: s.name, state: toServerState(s.status) })),
      });
    }
    return out;
  }

  if (type === 'assistant') {
    const out: AgentEvent[] = [];
    const parentId = parentIdOf(msg);
    for (const block of blocks(msg)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        // Subagent prose is dropped. The SDK's `forwardSubagentText` option
        // defaults to false, so these blocks should not arrive at all — this
        // is a defensive assertion, kept so a future default flip or a
        // second provider cannot silently reintroduce the token volume that
        // the nested-card design exists to avoid.
        if (parentId) { continue; }
        out.push({ kind: 'text', delta: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        // Truthy, not `typeof === 'string'`: a thinking block whose content is
        // withheld still arrives, carrying the empty string. Forwarding it
        // opens an assistant transcript item that renders nothing, and reads
        // downstream as "the model reasoned, and this is what it said".
        // claude-provider asks for `display: 'summarized'` so the content is
        // normally there; a redacted block can still arrive empty.
        if (parentId) { continue; }
        out.push({ kind: 'thinking', delta: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        out.push({
          kind: 'tool-start', id: block.id,
          tool: toToolCall(block.name, block.input),
          ...(parentId ? { parentId } : {}),
        });
      }
    }
    return out;
  }

  if (type === 'user') {
    const out: AgentEvent[] = [];
    const parentId = parentIdOf(msg);
    for (const block of blocks(msg)) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        out.push({
          kind: 'tool-end',
          id: block.tool_use_id,
          ok: block.is_error !== true,
          output: toToolOutput(block.content),
          ...(parentId ? { parentId } : {}),
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
    out.push({ kind: 'turn-end', reason: 'error', error: redactSecrets(detail || 'Agent error') });
    return out;
  }

  if (type === 'rate_limit_event') {
    // A signal, not data. The CLI pushes this whenever rate-limit info
    // changes, which is exactly when a pull is worth making — but the
    // payload carries no utilization at steady state (only `status` is
    // required, sdk.d.ts:4421), and its `resetsAt` is epoch SECONDS while
    // its `utilization`, when present at all, is a 0-1 fraction. Both
    // disagree with the structured response the numbers actually come from.
    // Reading values off it is what left the strip permanently blank.
    return [{ kind: 'usage-stale' }];
  }

  return [];
}

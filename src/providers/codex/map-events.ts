import type { AgentEvent, McpServerStatus } from '../types';
import type { RequestId } from './app-server';
import { approvalToolCall, toToolCall, toToolOutput } from './map-tools';
import type {
  McpServerStatusUpdatedNotification, McpServerStartupState, ThreadItem,
  ToolRequestUserInputParams,
} from './wire';

/**
 * Server requests that ask for typed input this panel still cannot render.
 *
 * `item/tool/requestUserInput` used to live here too, but it now maps to a
 * real `question` event (see `questionEventOf`) instead of being declined.
 * MCP elicitation is deliberately unmodelled and stays declined — see
 * codex-run.ts. Experimental upstream, and only fires if an MCP server uses
 * it.
 */
export const DECLINED_INPUT_METHODS = [
  'mcpServer/elicitation/request',
];

const APPROVAL_METHODS: Record<string, string> = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
};

/**
 * One notification to zero or more `AgentEvent`s.
 *
 * Zero is a normal answer, not a failure: `InitializeResponse` carries no
 * protocol version, so the only defense against a Codex upgrade changing the
 * wire is to ignore what we do not recognize. An unknown method and an
 * unknown item kind are both no-ops.
 */
export function mapNotification(method: string, params: unknown): AgentEvent[] {
  const p = (params ?? {}) as Record<string, never>;

  switch (method) {
    case 'thread/started': {
      const id = (p as { thread?: { id?: string } }).thread?.id;
      return id ? [{ kind: 'session', resumeToken: id }] : [];
    }
    case 'item/agentMessage/delta':
      return [{ kind: 'text', delta: String((p as { delta?: string }).delta ?? '') }];
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
      return [{ kind: 'thinking', delta: String((p as { delta?: string }).delta ?? '') }];
    case 'item/started':
      return startOf((p as { item?: ThreadItem }).item);
    case 'item/completed':
      return endOf((p as { item?: ThreadItem }).item);
    case 'turn/completed':
      return [{ kind: 'turn-end', reason: 'done' }];
    case 'error': {
      const e = p as { error?: { message?: string }; willRetry?: boolean };
      // A retry is not a turn ending. Reporting one would leave the session
      // idle while the provider is still working.
      if (e.willRetry) { return []; }
      return [{ kind: 'turn-end', reason: 'error', error: e.error?.message ?? 'Codex error' }];
    }
    case 'mcpServer/startupStatus/updated': {
      const status = mcpServerStatusOf(p as unknown as McpServerStatusUpdatedNotification);
      // Single-server, not a roster — see `mcpServerStatusOf`. `CodexRun`
      // accumulates these by name before anything downstream sees them.
      return status ? [{ kind: 'mcp-servers', servers: [status] }] : [];
    }
    case 'account/rateLimits/updated':
      // Documented as a sparse rolling update: a signal that a pull is due,
      // never the numbers themselves.
      return [{ kind: 'usage-stale' }];
    case 'thread/tokenUsage/updated': {
      const total = (p as { tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number } } })
        .tokenUsage?.total;
      if (!total) { return []; }
      return [{
        kind: 'usage',
        inputTokens: total.inputTokens ?? 0,
        outputTokens: total.outputTokens ?? 0,
      }];
    }
    default:
      return [];
  }
}

/**
 * Codex's four startup states to the panel's five.
 *
 * `starting`/`ready`/`failed` line up directly. The two that do not:
 *
 * - `needs-auth` has no state of its own on the wire — it is `failed` plus
 *   `failureReason: 'reauthenticationRequired'`, the one member that enum
 *   has. Collapsing it into a plain `failed` would tell a user to debug a
 *   server that only wants a login.
 * - `disabled` likewise has no state of its own. `cancelled` is the closest
 *   honest reading — a server whose startup was called off is configured but
 *   not running, which is exactly what `disabled` says, and the distinction
 *   the panel draws is "configured-but-off vs broken". It is a mapping, not
 *   a field Codex sends; if a future CLI adds a real disabled state this is
 *   the line to revisit.
 */
const MCP_STATES: Record<McpServerStartupState, McpServerStatus['state']> = {
  starting: 'pending',
  ready: 'connected',
  failed: 'failed',
  cancelled: 'disabled',
};

/**
 * One `mcpServer/startupStatus/updated` notification to one server's status,
 * or undefined if it names no server.
 *
 * Pure and single-server by design: the notification reports one server at a
 * time, while the `mcp-servers` event is a full-replacement list. Holding the
 * roster is `CodexRun`'s job, not a mapper's.
 */
export function mcpServerStatusOf(
  n: McpServerStatusUpdatedNotification | undefined,
): McpServerStatus | undefined {
  if (!n?.name) { return undefined; }
  const state = n.failureReason === 'reauthenticationRequired'
    ? 'needs-auth'
    : MCP_STATES[n.status] ?? 'pending';
  return { name: n.name, state, ...(n.error ? { error: n.error } : {}) };
}

function startOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item) { return []; }
  const tool = toToolCall(item);
  if (!tool) { return []; }
  return [{ kind: 'tool-start', id: item.id, tool }];
}

/**
 * A completed item carries the *authoritative* arguments, which are not always
 * the ones it started with: a `webSearch` reports `query: ''` at
 * `item/started` and only fills it in on completion (measured on codex-cli
 * 0.147.0). Re-emitting `toToolCall` on the end event is what lets the card
 * finally say what was searched — `AgentSession` overwrites the item's tool
 * when a `tool-end` carries one.
 */
function endOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item) { return []; }
  const tool = toToolCall(item);
  if (!tool) { return []; }
  return [{
    kind: 'tool-end', id: item.id, ok: succeeded(item),
    output: toToolOutput(item), tool,
  }];
}

/**
 * Codex reports failure differently per kind: a command has an exit code, and
 * everything else has a status string. Treating a missing signal as success
 * is deliberate — a tool that completed without saying otherwise did.
 *
 * A command still carries its own `status` (`CommandExecutionStatus`:
 * `'inProgress' | 'completed' | 'failed' | 'declined'`), and `status` is
 * checked FIRST because it can diverge from `exitCode`: a declined approval
 * or a spawn-level failure (measured live — a command that timed out before
 * ever exiting reported `status: 'failed', exitCode: 124`, which the
 * exit-code check alone would also have caught, but a command that never
 * spawned at all reports a `null` exitCode with a `'failed'`/`'declined'`
 * status, which the exit-code check alone reads as success — a null
 * `exitCode` means "no signal" only when nothing else says otherwise). Stderr
 * output does not affect this either way: `exitCode: 0` with stderr text in
 * `aggregatedOutput` is still success — measured live, a command that printed
 * profile-load warnings to stderr and still exited 0 completed with
 * `status: 'completed'`, and this function agrees.
 */
function succeeded(item: ThreadItem): boolean {
  if (item.type === 'commandExecution') {
    const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
    if (c.status === 'failed' || c.status === 'declined') { return false; }
    return c.exitCode === undefined || c.exitCode === null || c.exitCode === 0;
  }
  const status = (item as { status?: string }).status;
  return status !== 'failed' && status !== 'error';
}

/**
 * A server request to a `permission` event, or undefined if it is not an
 * approval at all.
 *
 * The event id is the JSON-RPC request id as a string: that is the handle
 * `respondToTool` needs to answer the right request, and `AgentEvent.id` is
 * typed as a string.
 */
export function approvalEventOf(
  method: string, id: RequestId, params: unknown,
): AgentEvent | undefined {
  if (!APPROVAL_METHODS[method]) { return undefined; }
  const tool = approvalToolCall(method, params);
  if (!tool) { return undefined; }
  return { kind: 'permission', id: String(id), tool };
}

/**
 * `item/tool/requestUserInput` -> a neutral question event. Codex declares no
 * multi-select: the response is an array, but nothing says more than one value
 * is permitted, so v1 maps single-select. See the spec's Open Item 2.
 */
export function questionEventOf(id: string | number, params: ToolRequestUserInputParams): AgentEvent {
  return {
    kind: 'question',
    id: String(id),
    blocking: params.isBlocking,
    questions: params.questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      ...(q.options ? { options: q.options.map((o) => ({ label: o.label, description: o.description })) } : {}),
      multiSelect: false,
      allowOther: q.isOther,
      secret: q.isSecret,
    })),
  };
}

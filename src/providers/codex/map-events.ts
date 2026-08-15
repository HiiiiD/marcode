import type { AgentEvent } from '../types';
import type { RequestId } from './app-server';
import type { ThreadItem } from './wire';

/** Item kinds that render as a tool row. Everything else is not a tool. */
const TOOL_KINDS = new Set([
  'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall', 'plan',
]);

/**
 * Server requests that ask for typed input rather than a yes/no.
 *
 * `ToolDecision` cannot express either one, and a turn that never gets an
 * answer hangs. The run declines them with a transcript note instead — see
 * codex-run.ts. Both are experimental and only fire if a tool or MCP server
 * uses them.
 */
export const DECLINED_INPUT_METHODS = [
  'item/tool/requestUserInput',
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

function startOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item || !TOOL_KINDS.has(item.type)) { return []; }
  return [{ kind: 'tool-start', id: item.id, name: item.type, input: inputOf(item) }];
}

function endOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item || !TOOL_KINDS.has(item.type)) { return []; }
  return [{ kind: 'tool-end', id: item.id, ok: succeeded(item), output: outputOf(item) }];
}

/** The fields worth showing in the tool header, per kind. */
function inputOf(item: ThreadItem): unknown {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return { command: c.command, cwd: c.cwd };
    }
    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      return { server: m.server, toolName: m.toolName };
    }
    default:
      return item;
  }
}

function outputOf(item: ThreadItem): unknown {
  if (item.type === 'commandExecution') {
    const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
    // Buffered, not streamed: `item/commandExecution/outputDelta` exists, but
    // AgentEvent has no tool-output-delta, so this matches Claude's behavior.
    return c.aggregatedOutput ?? '';
  }
  if (item.type === 'fileChange') {
    const f = item as Extract<ThreadItem, { type: 'fileChange' }>;
    // A typed array, not the whole item — the renderer narrows this shape in
    // tool-render.ts rather than guessing at an opaque record.
    return { changes: f.changes ?? [] };
  }
  return item;
}

/**
 * Codex reports failure differently per kind: a command has an exit code, and
 * everything else has a status string. Treating a missing signal as success
 * is deliberate — a tool that completed without saying otherwise did.
 */
function succeeded(item: ThreadItem): boolean {
  if (item.type === 'commandExecution') {
    const code = (item as Extract<ThreadItem, { type: 'commandExecution' }>).exitCode;
    return code === undefined || code === null || code === 0;
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
  const name = APPROVAL_METHODS[method];
  if (!name) { return undefined; }
  const p = (params ?? {}) as Record<string, unknown>;
  if (name === 'commandExecution') {
    return {
      kind: 'permission', id: String(id), name,
      input: { command: p.command, cwd: p.cwd, reason: p.reason },
    };
  }
  return { kind: 'permission', id: String(id), name, input: p };
}

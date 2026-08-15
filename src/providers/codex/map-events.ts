import type { AgentEvent, McpServerStatus } from '../types';
import type { RequestId } from './app-server';
import type {
  CommandAction, McpServerStatusUpdatedNotification, McpServerStartupState, ThreadItem,
} from './wire';

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
  if (!item || !TOOL_KINDS.has(item.type)) { return []; }
  return [{ kind: 'tool-start', id: item.id, name: item.type, input: inputOf(item) }];
}

/**
 * A completed item carries the *authoritative* arguments, which are not always
 * the ones it started with: a `webSearch` reports `query: ''` at
 * `item/started` and only fills it in on completion (measured on codex-cli
 * 0.147.0). Re-emitting `inputOf` on the end event is what lets the card
 * finally say what was searched — `AgentSession` overwrites the item's input
 * when a `tool-end` carries one.
 */
function endOf(item: ThreadItem | undefined): AgentEvent[] {
  if (!item || !TOOL_KINDS.has(item.type)) { return []; }
  return [{
    kind: 'tool-end', id: item.id, ok: succeeded(item),
    output: outputOf(item), input: inputOf(item),
  }];
}

/**
 * The command to *show* for a `commandExecution`.
 *
 * `ThreadItem.command` is the escaped invocation Codex spawns — on Windows,
 * `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "…"` with every
 * backslash doubled, which renders as a JSON-looking blob in a 300px header.
 * `commandActions` is the same call as Codex itself parsed it, and is
 * documented as being "for friendly display". The raw invocation is the
 * fallback, never the preference: a command with nothing parsed out of it is
 * still better shown than hidden.
 */
function displayCommand(command: string, actions: CommandAction[] | undefined): string {
  const parsed = (actions ?? [])
    .map((a) => a?.command)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  // One shell command can decompose into several actions (a pipeline). They
  // are joined by newline rather than a made-up operator — the header is a
  // single truncated line either way, and the expanded `$` block shows them
  // stacked without claiming a `&&` that was never written.
  return parsed.length > 0 ? parsed.join('\n') : command;
}

/** The fields worth showing in the tool header, per kind. */
function inputOf(item: ThreadItem): unknown {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return {
        command: displayCommand(c.command, c.commandActions), cwd: c.cwd,
        // Present only when Codex resolved the command to a trusted plugin
        // script — see the field docs on `ThreadItem` in wire.ts. Absent for
        // an ordinary shell command, so this never invents a skill identity.
        ...(c.pluginId ? { pluginId: c.pluginId } : {}),
        ...(c.scriptPath ? { scriptPath: c.scriptPath } : {}),
      };
    }
    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      return { server: m.server, toolName: m.tool };
    }
    case 'dynamicToolCall': {
      const d = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
      return { toolName: d.tool };
    }
    case 'webSearch': {
      const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
      return { query: w.query ?? '' };
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
  if (item.type === 'webSearch') {
    // `results` is opaque JSON by design upstream, so this reads only the two
    // fields every result type has carried and drops the rest — a raw dump of
    // ten search hits is a screen of escaped JSON in a sidebar.
    const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
    return (w.results ?? [])
      .map((raw) => {
        const r = (raw ?? {}) as { title?: unknown; url?: unknown };
        return [r.title, r.url].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n');
      })
      .filter((entry) => entry.length > 0)
      .join('\n\n');
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
  const name = APPROVAL_METHODS[method];
  if (!name) { return undefined; }
  const p = (params ?? {}) as Record<string, unknown>;
  if (name === 'commandExecution') {
    return {
      kind: 'permission', id: String(id), name,
      input: {
        // Same escaped-vs-parsed split as `item/started` — see
        // `displayCommand`. The approval card must read what the tool card
        // reads, or the user approves one spelling and sees another.
        command: displayCommand(
          typeof p.command === 'string' ? p.command : '',
          p.commandActions as CommandAction[] | undefined,
        ),
        cwd: p.cwd,
        reason: p.reason,
      },
    };
  }
  return { kind: 'permission', id: String(id), name, input: p };
}

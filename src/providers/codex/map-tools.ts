// Codex `ThreadItem`s to the canonical `ToolCall` union.
//
// Switches on the discriminated union in wire.ts, so classification is
// exhaustive against a schema rather than guessed from a name. Codex ships no
// tool names on this wire at all — `ThreadItem.type` is an internal
// discriminant (`commandExecution`, `fileChange`) that no user has typed or
// read — so `label` carries a short human word instead. That is a label, not
// a rebranding: it says what the Claude arm's own tool name says.
//
// Approvals build their call through the same functions as items, so an
// approval card and the tool card it becomes agree by construction.

import type { Field, FileEdit, ToolCall, ToolOutput } from '../canonical/tool-call';
import type { CommandAction, FileUpdateChange, ThreadItem } from './wire';

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  (typeof v === 'object' && v !== null && !Array.isArray(v)) ? v as Rec : {};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function compact<const T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Rec)[key] === undefined) { delete (value as Rec)[key]; }
  }
  return value;
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
 *
 * One shell command can decompose into several actions (a pipeline). They are
 * joined by newline rather than a made-up operator — the header is a single
 * truncated line either way, and the expanded `$` block shows them stacked
 * without claiming a `&&` that was never written.
 */
export function displayCommand(command: string, actions: CommandAction[] | undefined): string {
  const parsed = (actions ?? [])
    .map((action) => action?.command)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  return parsed.length > 0 ? parsed.join('\n') : command;
}

/**
 * `scriptPath` is plugin-relative, e.g. `skills/using-superpowers/SKILL.md`;
 * the segment right after `skills/` is the skill's own directory name, which
 * is the one thing a reader recognizes (it is what they typed to invoke it).
 * A script with no `skills/` segment — some other plugin-bundled script —
 * falls back to its containing directory, then to the bare filename, then to
 * `pluginId` as the last resort naming *something* trusted rather than
 * nothing. One resolved script names one skill; a command that happens to
 * touch several files still only carries one `scriptPath`, and this
 * deliberately does not try to enumerate the others — the fields don't
 * support that claim.
 */
function skillNameOf(pluginId: string | undefined, scriptPath: string | undefined): string | undefined {
  if (scriptPath) {
    const parts = scriptPath.split(/[\\/]/).filter(Boolean);
    const skillsIdx = parts.indexOf('skills');
    if (skillsIdx !== -1 && parts[skillsIdx + 1]) { return parts[skillsIdx + 1]; }
    if (parts.length >= 2) { return parts[parts.length - 2]; }
    if (parts.length === 1) { return parts[0]; }
  }
  return pluginId;
}

/** Codex's open `FileUpdateChange.kind` string to the canonical op. */
function toOp(kind: unknown): FileEdit['op'] {
  switch (kind) {
    case 'add': return 'create';
    case 'delete': return 'delete';
    case 'rename': return 'rename';
    default: return 'modify';
  }
}

function fileEdits(changes: unknown): FileEdit[] {
  if (!Array.isArray(changes)) { return []; }
  return changes
    .map((raw) => asRecord(raw) as unknown as Partial<FileUpdateChange>)
    .filter((change): change is FileUpdateChange => typeof change.path === 'string')
    .map((change) => compact({
      path: change.path,
      op: toOp(change.kind),
      unifiedDiff: str(change.diff),
    }));
}

export function toToolCall(item: ThreadItem): ToolCall | undefined {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
      return compact({
        kind: 'command', label: 'Shell',
        command: displayCommand(c.command, c.commandActions),
        cwd: str(c.cwd),
        skill: skillNameOf(str(c.pluginId), str(c.scriptPath)),
      });
    }

    case 'fileChange': {
      const f = item as Extract<ThreadItem, { type: 'fileChange' }>;
      return { kind: 'file-edit', label: 'Edit', files: fileEdits(f.changes) };
    }

    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
      const tool = str(m.tool) ?? '';
      const input = (m.arguments && typeof m.arguments === 'object') ? m.arguments : undefined;
      return compact({ kind: 'mcp', label: tool || m.server, server: m.server, tool, input });
    }

    case 'webSearch': {
      const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
      return compact({ kind: 'web', label: 'Web search', query: str(w.query) });
    }

    case 'plan': {
      const p = item as Extract<ThreadItem, { type: 'plan' }>;
      return { kind: 'plan', label: 'Plan', text: p.text };
    }

    case 'dynamicToolCall': {
      const d = item as Extract<ThreadItem, { type: 'dynamicToolCall' }>;
      return { kind: 'other', label: str(d.tool) ?? 'Tool', raw: item };
    }

    case 'subAgentActivity': {
      const s = item as Extract<ThreadItem, { type: 'subAgentActivity' }>;
      return {
        kind: 'subagent', label: 'Subagent', action: subagentActionOf(s.kind),
        agent: s.agentPath, target: s.agentThreadId,
      };
    }

    case 'imageGeneration': {
      const i = item as Extract<ThreadItem, { type: 'imageGeneration' }>;
      return compact({ kind: 'image', label: 'Image', note: str(i.revisedPrompt ?? undefined) });
    }

    // Every other item kind is deliberately not a tool. Parsing stays
    // tolerant: an unknown item is ignored rather than rendered.
    default:
      return undefined;
  }
}

/**
 * `SubAgentActivityKind` has no Claude-side counterpart to borrow spellings
 * from, so this picks the canonical `action` that reads closest to what each
 * one means: `'started'` opens the card the same way `Task` does, an
 * `'interacted'` exchange is one message in, and `'interrupted'` is the
 * terminal marker — closest in spirit to `TaskOutput` collecting a result.
 */
function subagentActionOf(kind: 'started' | 'interacted' | 'interrupted'): 'spawn' | 'message' | 'collect' {
  if (kind === 'started') { return 'spawn'; }
  if (kind === 'interacted') { return 'message'; }
  return 'collect';
}

export function toToolOutput(item: ThreadItem): ToolOutput {
  if (item.type === 'commandExecution') {
    const c = item as Extract<ThreadItem, { type: 'commandExecution' }>;
    // Buffered, not streamed: `item/commandExecution/outputDelta` exists, but
    // there is no tool-output-delta event, which matches Claude's behavior.
    const text = c.aggregatedOutput ?? '';
    return text.length > 0 ? { kind: 'text', text } : { kind: 'none' };
  }

  if (item.type === 'webSearch') {
    // `results` is opaque JSON by design upstream, so this reads only the two
    // fields every result type has carried and drops the rest — a raw dump of
    // ten search hits is a screen of escaped JSON in a sidebar.
    const w = item as Extract<ThreadItem, { type: 'webSearch' }>;
    const text = (w.results ?? [])
      .map((raw) => {
        const result = asRecord(raw);
        return [str(result.title), str(result.url)]
          .filter((part): part is string => part !== undefined)
          .join('\n');
      })
      .filter((entry) => entry.length > 0)
      .join('\n\n');
    return text.length > 0 ? { kind: 'text', text } : { kind: 'none' };
  }

  // A fileChange's diffs belong to the call, not to its result: the completed
  // item revises the ToolCall, and there is nothing left to show here.
  if (item.type === 'fileChange') { return { kind: 'none' }; }

  if (item.type === 'imageGeneration') {
    const i = item as Extract<ThreadItem, { type: 'imageGeneration' }>;
    return i.result ? { kind: 'image', dataUri: `data:image/png;base64,${i.result}` } : { kind: 'none' };
  }

  if (item.type === 'mcpToolCall') {
    const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>;
    if (m.result === undefined || m.result === null) { return { kind: 'none' }; }
    // `result` is the raw MCP `CallToolResult` envelope —
    // `{ content: [...], structuredContent, _meta }` — NOT a bare content
    // array; verified 2026-09-02 off a live session's row in
    // `~/.codex/thread_history_1.sqlite`. Reading `Array.isArray(m.result)`
    // here (as an earlier version of this function did) is always false for
    // real traffic, so every mcp tool's output fell to the raw JSON dump
    // below instead of unwrapping to text.
    if (Array.isArray(m.result.content)) {
      const text = m.result.content
        .map((block) => str(asRecord(block).text))
        .filter((part): part is string => part !== undefined)
        .join('\n');
      if (text.length > 0) { return { kind: 'text', text }; }
    }
    return { kind: 'json', value: m.result };
  }

  return { kind: 'none' };
}

const APPROVAL_KINDS: Record<string, 'command' | 'file-change' | 'permissions'> = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file-change',
  'item/permissions/requestApproval': 'permissions',
};

export function approvalToolCall(method: string, params: unknown): ToolCall | undefined {
  const kind = APPROVAL_KINDS[method];
  if (!kind) { return undefined; }
  const p = asRecord(params);

  if (kind === 'command') {
    return compact({
      kind: 'command', label: 'Shell',
      command: displayCommand(
        typeof p.command === 'string' ? p.command : '',
        p.commandActions as CommandAction[] | undefined,
      ),
      cwd: str(p.cwd),
      note: str(p.reason),
    });
  }

  if (kind === 'file-change') {
    return { kind: 'file-edit', label: 'Edit', files: fileEdits(p.changes) };
  }

  const fields: Field[] = [];
  const reason = str(p.reason);
  if (reason) { fields.push({ label: 'reason', value: reason }); }
  return compact({
    kind: 'other', label: 'Permission',
    fields: fields.length > 0 ? fields : undefined,
    raw: params,
  });
}

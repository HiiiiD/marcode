// Claude SDK tool calls to the canonical `ToolCall` union.
//
// Switches on the SDK's own tool names — no substring matching. A shared
// name heuristic (`includes('agent')` -> subagent) misclassifies silently:
// an MCP server named `agentql` would render as a spawned subagent. A wrong
// classification belongs in this file's tests, not in a regex every provider
// is subject to.
//
// Pure. Nothing here throws: an unreadable input yields the emptiest honest
// call, and an unrecognized name yields `other`.

import {
  parseMcpName, toTodoStatus,
  type Field, type FileEdit, type ToolCall, type ToolOutput,
} from '../canonical/tool-call';

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  (typeof v === 'object' && v !== null && !Array.isArray(v)) ? v as Rec : {};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Drops undefined-valued keys so tests can compare whole objects. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Rec)[key] === undefined) { delete (value as Rec)[key]; }
  }
  return value;
}

function fileEdit(record: Rec, op: FileEdit['op']): FileEdit {
  const before = str(record.old_string) ?? str(record.old_source);
  const after = str(record.new_string) ?? str(record.new_source) ?? str(record.content);
  const edits = before !== undefined || after !== undefined
    ? [compact({ before, after })]
    : undefined;
  return compact({
    path: str(record.file_path) ?? str(record.notebook_path) ?? str(record.path) ?? '',
    op,
    edits,
    replaceAll: record.replace_all === true ? true : undefined,
  });
}

function searchFilters(record: Rec): Field[] | undefined {
  const filters: Field[] = [];
  for (const key of ['glob', 'type', 'output_mode'] as const) {
    const value = str(record[key]);
    if (value) { filters.push({ label: key.replace('_', ' '), value }); }
  }
  return filters.length > 0 ? filters : undefined;
}

export function toToolCall(name: string, input: unknown): ToolCall {
  const record = asRecord(input);

  const mcp = parseMcpName(name);
  if (mcp) {
    return { kind: 'mcp', label: mcp.tool, server: mcp.server, tool: mcp.tool };
  }

  switch (name) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return compact({
        kind: 'command', label: name,
        command: str(record.command) ?? '',
        cwd: str(record.cwd),
        note: str(record.description),
        timeoutMs: num(record.timeout),
        background: record.run_in_background === true ? true : undefined,
      });

    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'file-edit', label: name, files: [fileEdit(record, 'modify')] };

    case 'Write':
      return { kind: 'file-edit', label: name, files: [fileEdit(record, 'create')] };

    case 'Read': {
      const offset = num(record.offset);
      return compact({
        kind: 'file-read', label: name,
        path: str(record.file_path) ?? '',
        range: offset !== undefined ? compact({ offset, limit: num(record.limit) }) : undefined,
        pages: str(record.pages),
      });
    }

    case 'Grep':
    case 'Glob':
      return compact({
        kind: 'search', label: name,
        pattern: str(record.pattern) ?? '',
        mode: name === 'Grep' ? 'content' : 'files',
        scope: str(record.path),
        filters: searchFilters(record),
      });

    case 'WebSearch':
    case 'WebFetch':
      return compact({
        kind: 'web', label: name,
        query: str(record.query),
        url: str(record.url),
        note: str(record.prompt),
      });

    case 'TodoWrite': {
      const todos = Array.isArray(record.todos) ? record.todos : [];
      return {
        kind: 'todos', label: name,
        items: todos
          .map(asRecord)
          .map((todo) => ({
            status: toTodoStatus(todo.status),
            text: str(todo.content) ?? str(todo.activeForm) ?? '',
          }))
          .filter((item) => item.text.length > 0),
      };
    }

    case 'Agent':
    case 'Task':
      return compact({
        kind: 'subagent', label: name, action: 'spawn',
        // `name` is the caller-chosen label an Agent call can carry instead
        // of a type; it is what SendMessage addresses later.
        agent: str(record.subagent_type) ?? str(record.name),
        model: str(record.model),
        isolation: str(record.isolation),
        prompt: str(record.prompt),
        summary: str(record.description),
        // The Agent/Task tool's own input field is `background` (sdk.d.ts) —
        // distinct from Bash's `run_in_background` above, a different tool
        // with its own input shape.
        background: record.background === true ? true : undefined,
      });

    case 'SendMessage':
      return compact({
        kind: 'subagent', label: name, action: 'message',
        target: str(record.to) ?? str(record.recipient),
        summary: str(record.summary),
        prompt: str(record.message) ?? str(record.content),
      });

    case 'TaskOutput':
      return compact({
        kind: 'subagent', label: name, action: 'collect',
        target: str(record.task_id),
        fields: record.block === true
          ? [{ label: 'wait', value: 'until done' }]
          : undefined,
      });

    case 'Skill':
      return compact({
        kind: 'command', label: name,
        command: str(record.args) ?? '',
        skill: str(record.skill),
      });

    default:
      return { kind: 'other', label: name, raw: input };
  }
}

/**
 * Unwraps a `tool_result` block's content. The Anthropic wire shape is either
 * a bare string or an array of content blocks, and the CLI is free to hand
 * back a plain object instead — all three appear.
 */
export function toToolOutput(content: unknown): ToolOutput {
  if (content === null || content === undefined) { return { kind: 'none' }; }

  if (typeof content === 'string') {
    if (content.length === 0) { return { kind: 'none' }; }
    // SendMessage's result is JSON-stringified into this same string field —
    // there is no tool name at this call site to gate on (`tool_result`
    // carries none), so the envelope is recognized by shape instead. Narrow
    // deliberately: only a `{success, message}` object with a *string*
    // `message` is unwrapped, so an unrelated JSON string that happens to
    // parse (any array, a bare number, an object missing either key) falls
    // straight through to today's behavior rather than being guessed at.
    try {
      const parsed: unknown = JSON.parse(content);
      const record = asRecord(parsed);
      if ('success' in record && typeof record.message === 'string') {
        return { kind: 'text', text: record.message };
      }
    } catch {
      // Not JSON — an ordinary text result, handled below.
    }
    return { kind: 'text', text: content };
  }

  if (Array.isArray(content)) {
    const text = content
      .map((block) => typeof block === 'string' ? block : str(asRecord(block).text))
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join('\n');
    return text.length > 0 ? { kind: 'text', text } : { kind: 'json', value: content };
  }

  const record = asRecord(content);
  const direct = str(record.text);
  if (direct) { return { kind: 'text', text: direct }; }
  const streams = [str(record.stdout), str(record.stderr)]
    .filter((part): part is string => part !== undefined);
  if (streams.length > 0) { return { kind: 'text', text: streams.join('\n') }; }

  return { kind: 'json', value: content };
}

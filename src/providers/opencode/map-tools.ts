import type { FileEdit, ToolCall, ToolOutput } from '../types';
import type { AcpToolCall, ToolMapper } from '../acp/map-updates';
import { toTodoStatus } from '../canonical/tool-call';

/** Absolute paths reach the transcript with POSIX separators — the spelling
 *  `claim-paths.ts` expects when it attributes a fleet-diff row. */
const posix = (p: string): string => p.replace(/\\/g, '/');

interface DiffBlock { type: 'diff'; path: string; oldText?: string | null; newText?: string | null }
interface ContentBlock { type: 'content'; content?: { type?: string; text?: string } }

const diffs = (c: AcpToolCall): DiffBlock[] =>
  (c.content ?? []).filter((b): b is DiffBlock => (b as DiffBlock)?.type === 'diff');

/**
 * The self-control server's own tool ids — see `self-control-mcp-server.ts`.
 * Unlike Claude's SDK tool names (`mcp__<server>__<tool>`, self-delimiting),
 * OpenCode's ACP `title` for an MCP call is just `<server>_<tool>` with no
 * marker for where the join is, so an id list is the only way to split it
 * back out without guessing.
 */
const SELF_CONTROL_TOOLS = [
  'marcode__spawn_session', 'marcode__send_message', 'marcode__list_sessions',
  'marcode__get_session_context', 'marcode__recall', 'marcode__recall_fetch',
];

function parseSelfControlTitle(title: string | undefined): { server: string; tool: string } | undefined {
  if (!title) { return undefined; }
  const tool = SELF_CONTROL_TOOLS.find((t) => title.endsWith(`_${t}`));
  if (!tool) { return undefined; }
  return { server: title.slice(0, title.length - tool.length - 1), tool };
}

/**
 * OpenCode's native `skill` tool (`packages/opencode/src/tool/skill.ts`)
 * hardcodes this exact template for every invocation — `title: \`Loaded
 * skill: ${info.name}\`` — with no distinguishing `kind`. Same title-not-kind
 * reasoning as `parseSelfControlTitle`, just a fixed prefix instead of a
 * known-tool-id list, since a skill's name is arbitrary.
 */
const SKILL_TITLE_PREFIX = 'Loaded skill: ';

function parseSkillTitle(title: string | undefined): string | undefined {
  return title?.startsWith(SKILL_TITLE_PREFIX) ? title.slice(SKILL_TITLE_PREFIX.length) : undefined;
}

/**
 * OpenCode's native `todowrite` tool (`packages/opencode/src/tool/todo.ts`)
 * takes exactly one parameter, `todos: Todo.Info[]` — that shape is the
 * signal, not `title` (`\`${n} todos\`` counts only the non-completed ones,
 * so it can misleadingly read "0 todos" on a freshly-completed list) or
 * `kind` (opencode sends no distinguishing kind for it at all).
 */
function parseTodos(rawInput: unknown): { status: ReturnType<typeof toTodoStatus>; text: string }[] | undefined {
  const todos = (rawInput as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) { return undefined; }
  return todos
    .map((t) => t as { content?: unknown; status?: unknown })
    .map((t) => ({ status: toTodoStatus(t.status), text: typeof t.content === 'string' ? t.content : '' }))
    .filter((item) => item.text.length > 0);
}

export function toToolCall(c: AcpToolCall): ToolCall {
  const raw = (c.rawInput ?? {}) as {
    command?: string; cwd?: string; filePath?: string; pattern?: string; path?: string;
    content?: string; name?: string;
  };
  const skill = parseSkillTitle(c.title);
  if (skill) { return { kind: 'command', label: 'Skill', command: '', skill: raw.name ?? skill }; }

  const todos = parseTodos(c.rawInput);
  if (todos) { return { kind: 'todos', label: 'Todos', items: todos }; }

  const mcp = parseSelfControlTitle(c.title);
  if (mcp) {
    const record = (c.rawInput ?? {}) as Record<string, unknown>;
    return {
      kind: 'mcp', label: mcp.tool, server: mcp.server, tool: mcp.tool,
      ...(Object.keys(record).length > 0 ? { input: record } : {}),
    };
  }

  switch (c.kind) {
    case 'execute': {
      // `tool_call` arrives with no command and only `cwd`; the command lands
      // on the following `tool_call_update`. The title is the best stand-in
      // until it does.
      const command = raw.command ?? c.title ?? 'shell';
      return raw.cwd
        ? { kind: 'command', label: 'Shell', command, cwd: posix(raw.cwd) }
        : { kind: 'command', label: 'Shell', command };
    }
    case 'edit': {
      const diffFiles: FileEdit[] = diffs(c).map((d) => ({
        path: posix(d.path),
        op: d.oldText ? 'modify' : 'create',
        edits: [d.oldText ? { before: d.oldText, after: d.newText ?? '' }
                          : { after: d.newText ?? '' }],
      }));
      if (diffFiles.length > 0) { return { kind: 'file-edit', label: 'Edit', files: diffFiles }; }
      // Observed live (opencode 1.18.30): a write/edit never sends a `diff`
      // content block at all — `content` is just the text confirmation
      // ("Wrote file successfully."), and the path only ever shows up in
      // `locations`/`rawInput.filePath`, same lag as `read` above. Without
      // that fallback the card shows the glyph and the word "Edit" with no
      // path and no diff at all.
      const path = c.locations?.[0]?.path ?? raw.filePath;
      if (!path) { return { kind: 'file-edit', label: 'Edit', files: [] }; }
      const output = (c.rawOutput ?? {}) as { metadata?: { exists?: boolean } };
      // `exists` is opencode's own answer to "was there a file here before
      // this write" — the only signal available, since there is no before
      // text to diff against either way. Missing (a `read`'s error frame
      // reused as a signal, or a vendor version that omits it) reads as
      // `modify`: the safer default is not to claim a create it can't back.
      const op: FileEdit['op'] = output.metadata?.exists === false ? 'create' : 'modify';
      const file: FileEdit = op === 'create' && raw.content !== undefined
        ? { path: posix(path), op, edits: [{ after: raw.content }] }
        : { path: posix(path), op };
      return { kind: 'file-edit', label: 'Edit', files: [file] };
    }
    case 'read': {
      // The opening `tool_call` carries an empty `locations` and an empty
      // `rawInput`; the path arrives on the `in_progress` frame, in whichever
      // of the two that agent version fills in.
      const path = c.locations?.[0]?.path ?? raw.filePath;
      if (path) { return { kind: 'file-read', label: 'Read', path: posix(path) }; }
      // Known kind, unknown path: the vendor's own title here is the literal
      // word `read`, and the card says what the call is either way.
      return { kind: 'other', label: 'Read', raw: c.rawInput };
    }
    case 'search': {
      // Observed live (opencode 1.18.30): the glob tool reports `kind:
      // 'search'` with `title: 'glob'` and `rawInput: { pattern, path }` —
      // the opening `tool_call` carries neither yet, same lag as `read`
      // above, so the pattern arrives on the `in_progress` frame. Nothing
      // observed yet distinguishes a content search (grep-like) from a
      // files search (glob-like) other than the vendor's own title, so that
      // is the only signal used here — never a name-substring guess on
      // anything else.
      const pattern = raw.pattern;
      if (pattern) {
        return {
          kind: 'search', label: c.title ?? 'Search', pattern,
          mode: c.title === 'grep' ? 'content' : 'files',
          ...(raw.path ? { scope: posix(raw.path) } : {}),
        };
      }
      return { kind: 'other', label: c.title ?? 'Search', raw: c.rawInput };
    }
    default:
      break;
  }
  // No substring classification on the tool name. An unrecognised kind is
  // rendered as itself rather than guessed into the wrong card.
  return { kind: 'other', label: c.title ?? c.kind ?? 'Tool', raw: c.rawInput };
}

export function toToolOutput(c: AcpToolCall): ToolOutput {
  if (c.kind === 'edit') { return { kind: 'none' }; }
  // Same reasoning as `edit`: the todo list is already the card's `items`
  // block, so re-showing opencode's JSON dump of that same array as text
  // output would just duplicate it.
  if (parseTodos(c.rawInput)) { return { kind: 'none' }; }
  const text = (c.content ?? [])
    .filter((b): b is ContentBlock => (b as ContentBlock)?.type === 'content')
    .map((b) => b.content?.text ?? '')
    .join('');
  return text ? { kind: 'text', text } : { kind: 'none' };
}

/**
 * OpenCode's `task` tool answers with the child session it ran in, under
 * `rawOutput.metadata.sessionId` — the only point the ACP wire ever names a
 * subagent's own session. Narrowed defensively rather than cast: the
 * overwhelming majority of completed calls carry no `metadata.sessionId` at
 * all and must be a silent no-op.
 */
function subagentSpawn(update: Record<string, unknown>): { taskToolCallId: string; childSessionId: string } | undefined {
  if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'completed') { return undefined; }
  const toolCallId = update.toolCallId;
  const rawOutput = update.rawOutput as { metadata?: { sessionId?: unknown } } | undefined;
  const childSessionId = rawOutput?.metadata?.sessionId;
  if (typeof toolCallId === 'string' && typeof childSessionId === 'string') {
    return { taskToolCallId: toolCallId, childSessionId };
  }
  return undefined;
}

export const openCodeTools: ToolMapper = { call: toToolCall, output: toToolOutput, subagentSpawn };

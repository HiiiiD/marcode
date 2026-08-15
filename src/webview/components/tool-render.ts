// Pure description layer for tool calls: turns an arbitrary `(name, input,
// output)` triple into a one-line header and a list of typed blocks. Kept
// React-free — same reason as tool-card-format.ts — so the whole mapping is
// unit-testable in the Node/mocha harness without a DOM.
//
// Nothing here trusts its input. A tool's arguments are model-generated and a
// tool's result is whatever the SDK handed back, so every accessor is a
// narrowing read with a fallback, and the last fallback is always pretty JSON.

import { safeStringify } from './tool-card-format';

/** Which lucide glyph the card draws. Resolved to a component in tool-body.tsx. */
export type ToolGlyph =
  | 'terminal' | 'file-pen' | 'file-plus' | 'file-text' | 'search'
  | 'folder-search' | 'globe' | 'list-todo' | 'bot' | 'send' | 'wrench';

export interface ToolHeader {
  glyph: ToolGlyph;
  /**
   * The tool's own name — familiarity beats a translated verb here — except
   * where the "name" is not a name a user has ever seen. See `LABELS`.
   */
  verb: string;
  /** The one argument worth a sidebar's width. Empty when there isn't one. */
  primary: string;
  /** Render `primary` in the editor font (a command, a path, a pattern). */
  mono: boolean;
  /** Full value for the `title` attribute when `primary` is truncated. */
  full?: string;
}

export type ToolBlock =
  /** Muted prose: a tool's own `description`, or a "not run yet" note. */
  | { kind: 'note'; text: string }
  /** A labelled scalar argument — `glob`, `limit`, `timeout`. */
  | { kind: 'field'; label: string; value: string }
  /** A shell command, drawn behind a `$` gutter. */
  | { kind: 'command'; text: string }
  /** A file path, drawn as a reveal-in-editor control. */
  | { kind: 'path'; path: string; hint?: string }
  /** Unified-ish diff lines, each already prefixed with ` `, `+` or `-`. */
  | { kind: 'diff'; lines: string[] }
  | { kind: 'todos'; items: { status: TodoStatus; text: string }[] }
  /** Free text shown in the editor font, clamped by the card. */
  | { kind: 'lines'; text: string; tone: 'output' | 'error' | 'code' }
  | { kind: 'json'; text: string };

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

type Rec = Record<string, unknown>;

const asRecord = (v: unknown): Rec =>
  (typeof v === 'object' && v !== null && !Array.isArray(v)) ? v as Rec : {};

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Normalizes a tool name for dispatch. The SDK's own tools are PascalCase
 * (`Bash`, `WebFetch`), a shell tool may arrive as `powershell`, and an MCP
 * tool's bare name is whatever its server chose.
 */
function key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Last two path segments — a bare basename loses the only disambiguator at 300px. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

/**
 * Unwraps a tool result into text. The Anthropic wire shape for `tool_result`
 * content is either a bare string or an array of content blocks, and a
 * provider is free to hand back a plain object instead — all three appear.
 */
export function outputText(output: unknown): string {
  if (output === null || output === undefined) { return ''; }
  if (typeof output === 'string') { return output; }
  if (Array.isArray(output)) {
    return output
      .map((block) => {
        if (typeof block === 'string') { return block; }
        const text = str(asRecord(block).text);
        return text ?? safeStringify(block);
      })
      .join('\n');
  }
  const record = asRecord(output);
  const text = str(record.text);
  if (text) { return text; }
  const stdout = str(record.stdout);
  const stderr = str(record.stderr);
  if (stdout || stderr) { return [stdout, stderr].filter(Boolean).join('\n'); }
  return safeStringify(output);
}

export interface Clamped {
  head: string[];
  tail: string[];
  /** Lines omitted between head and tail. Zero means nothing was dropped. */
  hidden: number;
}

/**
 * Head-and-tail clamp. A 500-line test run has its verdict in the last few
 * lines and its command echo in the first few; the middle is what buries the
 * rest of the transcript. Clamping only kicks in when it actually saves more
 * lines than the divider costs.
 */
export function clampLines(text: string, head = 12, tail = 8): Clamped {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length <= head + tail + 1) {
    return { head: lines, tail: [], hidden: 0 };
  }
  return {
    head: lines.slice(0, head),
    tail: lines.slice(lines.length - tail),
    hidden: lines.length - head - tail,
  };
}

/**
 * The few tools whose wire name is not a label.
 *
 * Claude's names are already the ones its own docs use — `Bash`, `Read`,
 * `Edit` — so they ship verbatim, and the default stays "show the tool's own
 * name". Codex has no tool names on this wire at all: what arrives is
 * `ThreadItem.type`, an internal discriminant (`commandExecution`,
 * `webSearch`, `fileChange`), which no user has typed or read anywhere. These
 * are short enough for a 300px sidebar and say the same thing the Claude arm
 * says with its own vocabulary — a label, not a rebranding.
 *
 * Keyed on the exact wire spelling, NOT on `key()`: Claude's own `WebSearch`
 * normalizes to the same `websearch` slug as Codex's `webSearch`, and it is a
 * real tool name that must keep shipping verbatim.
 */
const LABELS: Record<string, string> = {
  commandExecution: 'Shell',
  fileChange: 'Edit',
  webSearch: 'Web search',
  mcpToolCall: 'MCP',
  dynamicToolCall: 'Tool',
  plan: 'Plan',
};

export function describeTool(name: string, input: unknown): ToolHeader {
  const record = asRecord(input);
  const k = key(name);

  const header = (
    glyph: ToolGlyph, primary: string | undefined, mono: boolean, verbOverride?: string,
  ): ToolHeader => ({
    glyph, verb: verbOverride ?? LABELS[name] ?? name, mono,
    primary: primary ?? '',
    ...(primary && primary.length > 40 ? { full: primary } : {}),
  });

  switch (k) {
    case 'bash':
    case 'powershell':
    case 'bashoutput':
      return header('terminal', str(record.command) ?? str(record.description), true);

    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return header('file-pen', pathOf(record), true);

    case 'write':
      return header('file-plus', pathOf(record), true);

    case 'read':
      return header('file-text', pathOf(record), true);

    case 'grep':
      return header('search', str(record.pattern), true);

    case 'glob':
      return header('folder-search', str(record.pattern), true);

    case 'websearch':
      return header('globe', str(record.query), false);

    case 'webfetch':
      return header('globe', hostOf(str(record.url)), false);

    case 'todowrite': {
      const todos = Array.isArray(record.todos) ? record.todos : [];
      const active = todos.map(asRecord).find((t) => str(t.status) === 'in_progress');
      return header('list-todo', str(active?.activeForm) ?? str(active?.content)
        ?? `${todos.length} ${todos.length === 1 ? 'item' : 'items'}`, false);
    }

    // The subagent family. `Agent` is the current name and `Task` the older
    // one; both carry `subagent_type`, which is the identifying fact — "Explore"
    // says what is running where the tool's own name is only SDK vocabulary.
    case 'agent':
    case 'task':
      return header('bot', str(record.subagent_type) ?? str(record.name)
        ?? str(record.description), false);

    // `to` is an opaque agent id, so the model-written `summary` is the only
    // part of a SendMessage a reader can act on.
    case 'sendmessage':
      return header('send', str(record.summary) ?? str(record.to) ?? str(record.recipient), false);

    case 'taskoutput':
      return header('bot', str(record.task_id), true);

    // Codex tool kinds below. Names are the raw `ThreadItem.type` string from
    // map-events.ts, so no PascalCase translation happens for these.

    case 'commandexecution': {
      // Codex resolved this command to a trusted plugin script — `pluginId`/
      // `scriptPath` on `map-events.ts`'s `inputOf` only carry a value in
      // that case. That is a skill invocation, not a shell command anyone
      // typed, so it leads with the skill's identity — same reasoning as
      // `subagent_type` for the Agent tool, below — rather than the pwsh
      // wrapper that actually ran. The raw command is still one click away:
      // `describeInput`'s `commandexecution` case keeps the `command` block.
      const skill = skillNameOf(str(record.pluginId), str(record.scriptPath));
      if (skill) { return header('bot', skill, false, 'Skill'); }
      return header('terminal', str(record.command), true);
    }

    case 'filechange': {
      const paths = fileChangePaths(record.changes);
      const primary = paths.length === 1
        ? shortPath(paths[0])
        : paths.length > 1 ? `${paths.length} files` : undefined;
      return header('file-pen', primary, true);
    }

    case 'mcptoolcall': {
      const server = str(record.server);
      const toolName = str(record.toolName);
      const primary = server && toolName ? `${server} · ${toolName}` : server ?? toolName;
      return header('wrench', primary, false);
    }

    case 'dynamictoolcall':
      return header('wrench', str(record.toolName), false);

    case 'plan':
      return header('list-todo', str(record.text) ?? 'Plan', false);

    default: {
      // Not a tool we render bespoke. A single string argument is still worth
      // showing verbatim; anything else falls back to the JSON preview the
      // card has always used.
      const values = Object.values(record);
      const only = values.length === 1 ? str(values[0]) : undefined;
      return header('wrench', only, false);
    }
  }
}

/**
 * The skill (or plugin) identity of a `commandExecution` Codex resolved to a
 * trusted plugin script — undefined when neither field is set, which is the
 * overwhelming majority of commands (see `wire.ts`'s `ThreadItem` doc).
 *
 * `scriptPath` is plugin-relative, e.g. `skills/using-superpowers/SKILL.md`;
 * the segment right after `skills/` is the skill's own directory name, which
 * is the one thing a reader recognizes (it is what they typed to invoke it).
 * A script with no `skills/` segment — some other plugin-bundled script —
 * falls back to its containing directory, then to the bare filename, then to
 * `pluginId` as the last resort naming *something* trusted rather than
 * nothing. One resolved script names one skill; a command that happens to
 * touch several files (the two-`Get-Content` example this was built against)
 * still only carries one `scriptPath`, and this deliberately does not try to
 * enumerate the others — the fields don't support that claim.
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

function pathOf(record: Rec): string | undefined {
  const path = str(record.file_path) ?? str(record.notebook_path) ?? str(record.path);
  return path ? shortPath(path) : undefined;
}

/**
 * Path list out of a Codex `fileChange` item's `changes` field. `changes` is
 * typed `FileUpdateChange[]` upstream (wire.ts), but this still narrows
 * defensively — it also accepts an object keyed by path — since a tool
 * result crosses a JSON-RPC boundary and is worth treating as untrusted.
 */
function fileChangePaths(changes: unknown): string[] {
  if (Array.isArray(changes)) {
    return changes.map((c) => str(asRecord(c).path)).filter((p): p is string => p !== undefined);
  }
  if (typeof changes === 'object' && changes !== null) {
    return Object.keys(changes as Rec);
  }
  return [];
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) { return undefined; }
  // `URL` would throw on a model-generated non-URL, and this runs in render.
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
}

/** The argument side of the expanded card. */
export function describeInput(name: string, input: unknown): ToolBlock[] {
  const record = asRecord(input);
  const k = key(name);
  const blocks: ToolBlock[] = [];

  const note = str(record.description);

  switch (k) {
    case 'bash':
    case 'powershell': {
      const command = str(record.command);
      if (note) { blocks.push({ kind: 'note', text: note }); }
      if (command) { blocks.push({ kind: 'command', text: command }); }
      const timeout = num(record.timeout);
      if (timeout) { blocks.push({ kind: 'field', label: 'timeout', value: `${timeout / 1000}s` }); }
      if (record.run_in_background === true) {
        blocks.push({ kind: 'field', label: 'mode', value: 'background' });
      }
      break;
    }

    case 'edit':
    case 'write':
    case 'notebookedit': {
      const full = str(record.file_path) ?? str(record.notebook_path);
      if (full) { blocks.push({ kind: 'path', path: full }); }
      const lines = diffLines(record);
      if (lines) { blocks.push({ kind: 'diff', lines }); }
      if (record.replace_all === true) {
        blocks.push({ kind: 'field', label: 'scope', value: 'all occurrences' });
      }
      break;
    }

    case 'read': {
      const full = str(record.file_path);
      const offset = num(record.offset);
      const limit = num(record.limit);
      const hint = offset !== undefined
        ? `lines ${offset}–${limit === undefined ? 'end' : offset + limit}`
        : str(record.pages) ? `pages ${str(record.pages)}` : undefined;
      if (full) { blocks.push({ kind: 'path', path: full, ...(hint ? { hint } : {}) }); }
      break;
    }

    case 'grep': {
      const pattern = str(record.pattern);
      if (pattern) { blocks.push({ kind: 'command', text: pattern }); }
      const where = str(record.path);
      if (where) { blocks.push({ kind: 'path', path: where }); }
      for (const label of ['glob', 'type', 'output_mode'] as const) {
        const value = str(record[label]);
        if (value) { blocks.push({ kind: 'field', label: label.replace('_', ' '), value }); }
      }
      break;
    }

    case 'glob': {
      const pattern = str(record.pattern);
      if (pattern) { blocks.push({ kind: 'command', text: pattern }); }
      const where = str(record.path);
      if (where) { blocks.push({ kind: 'path', path: where }); }
      break;
    }

    case 'websearch': {
      const query = str(record.query);
      if (query) { blocks.push({ kind: 'field', label: 'query', value: query }); }
      break;
    }

    case 'webfetch': {
      const url = str(record.url);
      if (url) { blocks.push({ kind: 'field', label: 'url', value: url }); }
      const prompt = str(record.prompt);
      if (prompt) { blocks.push({ kind: 'note', text: prompt }); }
      break;
    }

    case 'todowrite': {
      const todos = (Array.isArray(record.todos) ? record.todos : []).map(asRecord);
      const items = todos.map((todo) => ({
        status: todoStatus(str(todo.status)),
        text: str(todo.content) ?? str(todo.activeForm) ?? '',
      })).filter((t) => t.text.length > 0);
      if (items.length > 0) { blocks.push({ kind: 'todos', items }); }
      break;
    }

    case 'commandexecution': {
      // The skill identity leads, same as the header — but the raw command
      // that actually ran must still be reachable here, not hidden behind it.
      const skill = skillNameOf(str(record.pluginId), str(record.scriptPath));
      if (skill) { blocks.push({ kind: 'field', label: 'skill', value: skill }); }
      const command = str(record.command);
      if (command) { blocks.push({ kind: 'command', text: command }); }
      const cwd = str(record.cwd);
      if (cwd) { blocks.push({ kind: 'path', path: cwd }); }
      break;
    }

    case 'mcptoolcall': {
      const server = str(record.server);
      if (server) { blocks.push({ kind: 'field', label: 'server', value: server }); }
      const toolName = str(record.toolName);
      if (toolName) { blocks.push({ kind: 'field', label: 'tool', value: toolName }); }
      break;
    }

    case 'agent':
    case 'task': {
      if (note) { blocks.push({ kind: 'note', text: note }); }
      const agent = str(record.subagent_type);
      if (agent) { blocks.push({ kind: 'field', label: 'agent', value: agent }); }
      const model = str(record.model);
      if (model) { blocks.push({ kind: 'field', label: 'model', value: model }); }
      const isolation = str(record.isolation);
      if (isolation) { blocks.push({ kind: 'field', label: 'isolation', value: isolation }); }
      // The brief is the whole point of the card — a subagent's transcript is
      // not in this panel, so this is the only place its instructions appear.
      const prompt = str(record.prompt);
      if (prompt) { blocks.push({ kind: 'lines', text: prompt, tone: 'output' }); }
      break;
    }

    case 'sendmessage': {
      const to = str(record.to) ?? str(record.recipient);
      if (to) { blocks.push({ kind: 'field', label: 'to', value: to }); }
      const summary = str(record.summary);
      if (summary) { blocks.push({ kind: 'note', text: summary }); }
      const message = str(record.message) ?? str(record.content);
      if (message) { blocks.push({ kind: 'lines', text: message, tone: 'output' }); }
      break;
    }

    case 'taskoutput': {
      const taskId = str(record.task_id);
      if (taskId) { blocks.push({ kind: 'field', label: 'task', value: taskId }); }
      // Blocking is what distinguishes a collect-now call from a peek, and it
      // explains a card that sits running for ten minutes.
      if (record.block === true) {
        blocks.push({ kind: 'field', label: 'wait', value: 'until done' });
      }
      const timeout = num(record.timeout);
      if (timeout) { blocks.push({ kind: 'field', label: 'timeout', value: `${timeout / 1000}s` }); }
      break;
    }

    // fileChange, dynamicToolCall and plan carry no fixed *input* shape worth
    // a bespoke block — fileChange's `changes` is rendered from the *output*
    // side instead (describeOutput's `filechange` branch, below). They fall
    // through to the JSON preview here, same as any tool this panel has
    // never heard of.

    default: {
      // An MCP tool, or one this panel has never heard of. An empty object
      // gets no block at all — `{}` in a pane is worse than nothing.
      const empty = input === null || input === undefined
        || (typeof input === 'object' && Object.keys(input as object).length === 0);
      if (!empty) { blocks.push({ kind: 'json', text: safeStringify(input) }); }
    }
  }

  return blocks;
}

function todoStatus(value: string | undefined): TodoStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

/**
 * Builds `-`/`+` lines for the edit family. Shared with the permission card so
 * an edit looks the same when it is being approved and after it has run.
 */
export function diffLines(input: unknown): string[] | undefined {
  const record = asRecord(input);
  const oldText = str(record.old_string) ?? str(record.old_source);
  const newText = str(record.new_string) ?? str(record.new_source) ?? str(record.content);
  if (oldText === undefined && newText === undefined) { return undefined; }

  const lines: string[] = [];
  if (oldText !== undefined) { lines.push(...oldText.split('\n').map((l) => `-${l}`)); }
  if (newText !== undefined) { lines.push(...newText.split('\n').map((l) => `+${l}`)); }
  return lines;
}

/**
 * Strips a unified diff's `---`/`+++` file headers and `@@` hunk headers,
 * keeping only the body lines — already prefixed with `' '`/`'+'`/`'-'` by
 * the unified-diff format itself, which is exactly what the `diff` block
 * wants.
 *
 * This has to be positional, not prefix-matching: a deleted or added line
 * can itself start with `--`/`++` (CSS custom properties — `-color-primary`
 * with the diff's own `-`/`+` glued on reads as `--color-primary` — SQL/Lua
 * `--` comments, C-style `++i`), so a bare `startsWith('---')` over every
 * line drops real content. `---`/`+++` only ever appear in the file header,
 * before the first `@@` hunk header; once a hunk has started, every
 * remaining line is body, and only further `@@` lines are stripped.
 */
function diffBodyLines(diff: string): string[] {
  const body: string[] = [];
  let seenHunk = false;
  for (const line of diff.split('\n')) {
    if (line.length === 0) { continue; } // typically a trailing newline, never real content
    if (line.startsWith('@@')) { seenHunk = true; continue; }
    if (!seenHunk && (line.startsWith('---') || line.startsWith('+++'))) { continue; }
    body.push(line);
  }
  return body;
}

/**
 * A Codex `fileChange` result: one `path` + `diff` block pair per touched
 * file, mirroring how the Claude arm pairs them for `edit` / `write`.
 * `changes` is an array typed upstream by map-events.ts; still narrowed
 * defensively since a tool result crosses a JSON-RPC boundary.
 */
function fileChangeBlocks(output: unknown): ToolBlock[] {
  const changes = asRecord(output).changes;
  const blocks: ToolBlock[] = [];
  if (Array.isArray(changes)) {
    for (const raw of changes) {
      const change = asRecord(raw);
      const path = str(change.path);
      if (path) { blocks.push({ kind: 'path', path }); }
      const diff = str(change.diff);
      if (diff) {
        const lines = diffBodyLines(diff);
        // A rename- or mode-only change has headers and no body left after
        // stripping them; an empty diff block would show an empty bordered
        // box with nothing in it.
        if (lines.length > 0) { blocks.push({ kind: 'diff', lines }); }
      }
    }
  }
  return blocks.length > 0 ? blocks : [{ kind: 'note', text: 'No file changes.' }];
}

/** The result side of the expanded card. */
export function describeOutput(
  name: string, output: unknown, state: 'running' | 'ok' | 'error',
): ToolBlock[] {
  if (state === 'running') { return []; }

  if (state === 'ok' && key(name) === 'filechange') { return fileChangeBlocks(output); }

  const text = outputText(output);
  if (text.trim().length === 0) {
    return state === 'error'
      ? [{ kind: 'note', text: 'Failed with no output.' }]
      : [{ kind: 'note', text: 'No output.' }];
  }

  if (state === 'error') { return [{ kind: 'lines', text, tone: 'error' }]; }

  const k = key(name);

  // SendMessage answers with a JSON envelope — `{"success":true,"message":
  // "Agent \"…\" had no active task; resumed from transcript…"}` — whose only
  // readable part is `message`. Left alone it renders as a line of escaped
  // JSON, which is the noisiest possible way to say "queued".
  if (k === 'sendmessage') {
    const note = str(asRecord(parseJson(text)).message);
    if (note) { return [{ kind: 'note', text: note }]; }
  }

  const tone = k === 'read' || k === 'glob' || k === 'grep' ? 'code' : 'output';
  return [{ kind: 'lines', text, tone }];
}

/** `JSON.parse` that returns `undefined` instead of throwing on a non-JSON result. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

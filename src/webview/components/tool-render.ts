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
  | 'folder-search' | 'globe' | 'list-todo' | 'wrench';

export interface ToolHeader {
  glyph: ToolGlyph;
  /** The tool's own name — familiarity beats a translated verb here. */
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

export function describeTool(name: string, input: unknown): ToolHeader {
  const record = asRecord(input);
  const k = key(name);

  const header = (
    glyph: ToolGlyph, primary: string | undefined, mono: boolean,
  ): ToolHeader => ({
    glyph, verb: name, mono,
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

    // Codex tool kinds below. Names are the raw `ThreadItem.type` string from
    // map-events.ts, so no PascalCase translation happens for these.

    case 'commandexecution':
      return header('terminal', str(record.command), true);

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

function pathOf(record: Rec): string | undefined {
  const path = str(record.file_path) ?? str(record.notebook_path) ?? str(record.path);
  return path ? shortPath(path) : undefined;
}

/**
 * Best-effort path list out of a Codex `fileChange` item's `changes` field.
 * That field is typed `unknown` upstream (map-events.ts / wire.ts) — Codex
 * has not published its shape here yet — so this only recognizes the two
 * plausible container shapes (an array of `{ path }` entries, or an object
 * keyed by path) and returns nothing rather than guessing further.
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

    // fileChange, dynamicToolCall and plan carry no fixed input shape worth a
    // bespoke block (`changes` in particular is typed `unknown` upstream —
    // see map-events.ts). They fall through to the JSON preview below, same
    // as any tool this panel has never heard of.

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

/** The result side of the expanded card. */
export function describeOutput(
  name: string, output: unknown, state: 'running' | 'ok' | 'error',
): ToolBlock[] {
  if (state === 'running') { return []; }

  const text = outputText(output);
  if (text.trim().length === 0) {
    return state === 'error'
      ? [{ kind: 'note', text: 'Failed with no output.' }]
      : [{ kind: 'note', text: 'No output.' }];
  }

  if (state === 'error') { return [{ kind: 'lines', text, tone: 'error' }]; }

  const k = key(name);
  const tone = k === 'read' || k === 'glob' || k === 'grep' ? 'code' : 'output';
  return [{ kind: 'lines', text, tone }];
}

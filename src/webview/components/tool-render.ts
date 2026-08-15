// Pure description layer for tool calls: turns a canonical `ToolCall` (plus
// its `ToolOutput`) into a one-line header and a list of typed blocks. Kept
// React-free — same reason as tool-card-format.ts — so the whole mapping is
// unit-testable in the Node/mocha harness without a DOM.
//
// Classification itself happens upstream, in each provider's adapter — this
// module only renders the canonical shape it produces. Nothing here branches
// on a tool's name.

import { safeStringify } from './tool-card-format';
import type { FileEdit, ToolCall, ToolOutput } from '../../protocol/messages';

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

/** Last two path segments — a bare basename loses the only disambiguator at 300px. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
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

/** `full` is only worth carrying when the header will actually truncate. */
function header(glyph: ToolGlyph, verb: string, primary: string, mono: boolean): ToolHeader {
  return { glyph, verb, mono, primary, ...(primary.length > 40 ? { full: primary } : {}) };
}

export function describeTool(tool: ToolCall): ToolHeader {
  switch (tool.kind) {
    case 'command':
      return header('terminal', tool.label, tool.command, true);

    case 'file-edit': {
      const glyph = tool.files.length > 0 && tool.files.every((f) => f.op === 'create')
        ? 'file-plus'
        : 'file-pen';
      const primary = tool.files.length === 1
        ? shortPath(tool.files[0].path)
        : tool.files.length > 1 ? `${tool.files.length} files` : '';
      return header(glyph, tool.label, primary, true);
    }

    case 'file-read':
      return header('file-text', tool.label, shortPath(tool.path), true);

    case 'search':
      return header(
        tool.mode === 'content' ? 'search' : 'folder-search',
        tool.label, tool.pattern, true,
      );

    case 'web':
      return header('globe', tool.label, tool.query ?? hostOf(tool.url) ?? '', false);

    case 'todos': {
      const active = tool.items.find((item) => item.status === 'in_progress');
      const primary = active?.text
        ?? `${tool.items.length} ${tool.items.length === 1 ? 'item' : 'items'}`;
      return header('list-todo', tool.label, primary, false);
    }

    case 'plan':
      return header('list-todo', tool.label, tool.text, false);

    case 'subagent':
      return header(
        tool.action === 'message' ? 'send' : 'bot', tool.label,
        tool.agent ?? tool.summary ?? tool.target ?? '', false,
      );

    case 'mcp':
      return header('wrench', tool.label,
        tool.server && tool.tool ? `${tool.server} · ${tool.tool}` : tool.server || tool.tool,
        false);

    case 'other':
      return header('wrench', tool.label, tool.fields?.[0]?.value ?? '', false);
  }
}

function editBlocks(file: FileEdit): ToolBlock[] {
  const blocks: ToolBlock[] = [{ kind: 'path', path: file.path }];
  const lines: string[] = [];
  for (const edit of file.edits ?? []) {
    if (edit.before !== undefined) {
      lines.push(...edit.before.split('\n').map((line) => `-${line}`));
    }
    if (edit.after !== undefined) {
      lines.push(...edit.after.split('\n').map((line) => `+${line}`));
    }
  }
  if (file.unifiedDiff) { lines.push(...diffBodyLines(file.unifiedDiff)); }
  // A rename- or mode-only change has headers and no body left after
  // stripping them; an empty diff block is an empty bordered box.
  if (lines.length > 0) { blocks.push({ kind: 'diff', lines }); }
  if (file.replaceAll) {
    blocks.push({ kind: 'field', label: 'scope', value: 'all occurrences' });
  }
  return blocks;
}

export function describeInput(tool: ToolCall): ToolBlock[] {
  const blocks: ToolBlock[] = [];

  switch (tool.kind) {
    case 'command':
      if (tool.note) { blocks.push({ kind: 'note', text: tool.note }); }
      if (tool.command) { blocks.push({ kind: 'command', text: tool.command }); }
      if (tool.cwd) { blocks.push({ kind: 'path', path: tool.cwd }); }
      if (tool.timeoutMs) {
        blocks.push({ kind: 'field', label: 'timeout', value: `${tool.timeoutMs / 1000}s` });
      }
      if (tool.background) {
        blocks.push({ kind: 'field', label: 'mode', value: 'background' });
      }
      break;

    case 'file-edit':
      for (const file of tool.files) { blocks.push(...editBlocks(file)); }
      break;

    case 'file-read': {
      const hint = tool.range
        ? `lines ${tool.range.offset}–${tool.range.limit === undefined
            ? 'end' : tool.range.offset + tool.range.limit}`
        : tool.pages ? `pages ${tool.pages}` : undefined;
      blocks.push({ kind: 'path', path: tool.path, ...(hint ? { hint } : {}) });
      break;
    }

    case 'search':
      if (tool.pattern) { blocks.push({ kind: 'command', text: tool.pattern }); }
      if (tool.scope) { blocks.push({ kind: 'path', path: tool.scope }); }
      for (const filter of tool.filters ?? []) { blocks.push({ kind: 'field', ...filter }); }
      break;

    case 'web':
      if (tool.query) { blocks.push({ kind: 'field', label: 'query', value: tool.query }); }
      if (tool.url) { blocks.push({ kind: 'field', label: 'url', value: tool.url }); }
      if (tool.note) { blocks.push({ kind: 'note', text: tool.note }); }
      break;

    case 'todos':
      if (tool.items.length > 0) { blocks.push({ kind: 'todos', items: [...tool.items] }); }
      break;

    case 'plan':
      blocks.push({ kind: 'lines', text: tool.text, tone: 'output' });
      break;

    case 'subagent':
      if (tool.summary) { blocks.push({ kind: 'note', text: tool.summary }); }
      if (tool.agent) { blocks.push({ kind: 'field', label: 'agent', value: tool.agent }); }
      if (tool.target) { blocks.push({ kind: 'field', label: 'to', value: tool.target }); }
      if (tool.model) { blocks.push({ kind: 'field', label: 'model', value: tool.model }); }
      if (tool.isolation) {
        blocks.push({ kind: 'field', label: 'isolation', value: tool.isolation });
      }
      for (const field of tool.fields ?? []) { blocks.push({ kind: 'field', ...field }); }
      // The brief is the whole point of the card — a subagent's transcript is
      // not in this panel, so this is the only place its instructions appear.
      if (tool.prompt) { blocks.push({ kind: 'lines', text: tool.prompt, tone: 'output' }); }
      break;

    case 'mcp':
      if (tool.server) { blocks.push({ kind: 'field', label: 'server', value: tool.server }); }
      if (tool.tool) { blocks.push({ kind: 'field', label: 'tool', value: tool.tool }); }
      break;

    case 'other': {
      for (const field of tool.fields ?? []) { blocks.push({ kind: 'field', ...field }); }
      const empty = tool.raw === null || tool.raw === undefined
        || (typeof tool.raw === 'object' && Object.keys(tool.raw as object).length === 0);
      if (!empty) { blocks.push({ kind: 'json', text: safeStringify(tool.raw) }); }
      break;
    }
  }

  return blocks;
}

export function describeOutput(
  kind: ToolCall['kind'],
  output: ToolOutput | undefined,
  state: 'running' | 'ok' | 'error',
): ToolBlock[] {
  if (state === 'running') { return []; }

  if (output === undefined || output.kind === 'none') {
    return state === 'error'
      ? [{ kind: 'note', text: 'Failed with no output.' }]
      : [{ kind: 'note', text: 'No output.' }];
  }

  if (output.kind === 'json') { return [{ kind: 'json', text: safeStringify(output.value) }]; }

  if (output.text.trim().length === 0) {
    return state === 'error'
      ? [{ kind: 'note', text: 'Failed with no output.' }]
      : [{ kind: 'note', text: 'No output.' }];
  }

  if (state === 'error') { return [{ kind: 'lines', text: output.text, tone: 'error' }]; }

  const tone = kind === 'file-read' || kind === 'search' ? 'code' : 'output';
  return [{ kind: 'lines', text: output.text, tone }];
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) { return undefined; }
  // `URL` would throw on a model-generated non-URL, and this runs in render.
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1] : url;
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

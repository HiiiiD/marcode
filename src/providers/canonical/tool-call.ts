// The canonical description of one tool call, produced by a provider's
// adapter and consumed by the webview renderer. A provider classifies against
// its own typed wire schema; nothing downstream ever branches on a tool's
// name. Adding a provider means adding one `map-tools.ts`, never editing
// `src/webview/components/tool-render.ts`.
//
// Imports nothing from `vscode` and nothing from `src/webview/`.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type Field = { label: string; value: string };

export interface FileEdit {
  /** Absolute where the provider gave one. POSIX separators. */
  path: string;
  op: 'create' | 'modify' | 'delete' | 'rename';
  /** Before/after pairs, as Claude's edit family reports them. */
  edits?: { before?: string; after?: string }[];
  /** A full unified diff, `---`/`+++`/`@@` headers included, as Codex reports it. */
  unifiedDiff?: string;
  replaceAll?: boolean;
}

/**
 * `label` is display-only: the provider's own word for the call (`Bash`,
 * `Edit`, `Shell`). Nothing branches on it — every rendering decision comes
 * off `kind` and the typed fields beside it.
 *
 * `other` is the only arm carrying `raw`, because the JSON fallback has
 * nothing else to show. Every other arm has already extracted what matters,
 * so carrying the raw input too would duplicate a large `Write`'s whole
 * content into the transcript.
 */
export type ToolCall =
  | { kind: 'command'; label: string; command: string; cwd?: string;
      background?: boolean; timeoutMs?: number; note?: string; skill?: string }
  | { kind: 'file-edit'; label: string; files: FileEdit[] }
  | { kind: 'file-read'; label: string; path: string;
      range?: { offset: number; limit?: number }; pages?: string }
  | { kind: 'search'; label: string; pattern: string; mode: 'content' | 'files';
      scope?: string; filters?: Field[] }
  | { kind: 'web'; label: string; query?: string; url?: string; note?: string }
  | { kind: 'todos'; label: string; items: { status: TodoStatus; text: string }[] }
  | { kind: 'plan'; label: string; text: string }
  | { kind: 'subagent'; label: string; action: 'spawn' | 'message' | 'collect';
      agent?: string; model?: string; isolation?: string; target?: string;
      summary?: string; prompt?: string; fields?: Field[] }
  | { kind: 'mcp'; label: string; server: string; tool: string }
  | { kind: 'other'; label: string; fields?: Field[]; raw: unknown };

/**
 * A tool's result, already unwrapped by the adapter that understands the
 * backend's shape. `none` is a positive answer — the call produced no result
 * worth showing — and is what a Codex `fileChange` reports, since its diffs
 * belong to the call rather than to its result.
 */
export type ToolOutput =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'json'; value: unknown };

const MCP_PREFIX = 'mcp__';
const MCP_SEP = '__';

/**
 * Splits `mcp__<server>__<tool>`.
 *
 * The server is the first segment after the prefix; everything after the next
 * separator is the tool, separators included — a legitimate
 * `mcp__github__list__repos` has a tool name that contains the separator, so
 * requiring exactly three segments would mis-handle it.
 *
 * Anything that does not split cleanly returns undefined. A guess would put a
 * wrong server badge on a transcript item that is then persisted and never
 * re-derived.
 */
export function parseMcpName(raw: string): { server: string; tool: string } | undefined {
  if (!raw.startsWith(MCP_PREFIX)) { return undefined; }
  const rest = raw.slice(MCP_PREFIX.length);
  const at = rest.indexOf(MCP_SEP);
  if (at <= 0) { return undefined; }
  const tool = rest.slice(at + MCP_SEP.length);
  if (!tool) { return undefined; }
  return { server: rest.slice(0, at), tool };
}

/** Anything that is not one of the two non-default states is `pending`. */
export function toTodoStatus(raw: unknown): TodoStatus {
  return raw === 'completed' || raw === 'in_progress' ? raw : 'pending';
}

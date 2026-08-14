const PREFIX = 'mcp__';
const SEP = '__';

export interface ParsedToolName {
  /** The bare tool name, with any `mcp__<server>__` prefix removed. */
  name: string;
  /** The MCP server, when the name carried one. */
  mcpServer?: string;
}

/**
 * Splits `mcp__<server>__<tool>`.
 *
 * The server is the first segment after the prefix; everything after the
 * next separator is the tool, separators included. Requiring exactly three
 * segments would mis-handle a legitimate `mcp__github__list__repos`, whose
 * tool name simply contains the separator.
 *
 * Anything that does not split cleanly is returned unchanged with no
 * `mcpServer`. A guess would put a wrong server badge on a transcript item
 * that is then persisted and never re-derived.
 */
export function parseToolName(raw: string): ParsedToolName {
  if (!raw.startsWith(PREFIX)) { return { name: raw }; }
  const rest = raw.slice(PREFIX.length);
  const at = rest.indexOf(SEP);
  if (at <= 0) { return { name: raw }; }
  const server = rest.slice(0, at);
  const tool = rest.slice(at + SEP.length);
  if (!tool) { return { name: raw }; }
  return { name: tool, mcpServer: server };
}

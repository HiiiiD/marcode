import type { EditorContext } from './types';

/**
 * The one rendering of an editor context that goes to a model. Providers
 * share it so a prompt looks the same whichever agent is behind the session.
 *
 * XML-ish rather than a fenced code block: fences collide with fences inside
 * the selected text, and attributes carry the line numbers without a
 * convention the model has to infer.
 */
export function formatEditorContext(ctx: EditorContext): string {
  const head = `<editor-context path="${escapeAttr(ctx.path)}"`
    + ` language="${escapeAttr(ctx.languageId)}"`;

  if (!ctx.selection) { return `${head} />`; }

  const truncated = ctx.selection.truncated ? ' truncated="true"' : '';
  const body = ctx.selection.ranges
    .map((r) => `<range lines="${r.startLine}-${r.endLine}">\n${r.text}\n</range>`)
    .join('\n');
  return `${head}${truncated}>\n${body}\n</editor-context>`;
}

/**
 * A path is not trusted input for this purpose — a filename may legally
 * contain a quote or an angle bracket, which would otherwise close the
 * attribute early and hand the model a malformed, confusing block.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

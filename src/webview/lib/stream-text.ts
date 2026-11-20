const MAX_HELD = 240;

/**
 * The part of a still-streaming message that is worth showing yet.
 *
 * A token-streaming backend (Codex, OpenCode) hands over a few characters at a
 * time, and rendering each one re-parses the Markdown: half-written bold,
 * list markers and links flicker, and the line grows under the reader's eye.
 * Showing only whole lines — or, before the first newline, whole sentences —
 * makes the text arrive in readable steps instead, the way a backend that
 * emits finished blocks already looks. Once the turn moves on, the full text
 * is shown.
 */
export function settledPrefix(text: string): string {
  const line = text.lastIndexOf('\n');
  if (line >= 0) { return text.slice(0, line + 1); }
  const sentence = /[.!?](?=\s)/g;
  let end = -1;
  for (let m = sentence.exec(text); m !== null; m = sentence.exec(text)) { end = m.index + 1; }
  if (end >= 0) { return text.slice(0, end); }
  if (text.length > MAX_HELD) {
    const space = text.lastIndexOf(' ');
    return space > 0 ? text.slice(0, space) : '';
  }
  return '';
}

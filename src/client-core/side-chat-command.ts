/**
 * The question after `/side` or `/btw` (empty for the bare command), or
 * `undefined` when `text` is anything else, including `/sidebar`.
 */
export function sideChatText(text: string): string | undefined {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? (match[1] ?? '').trim() : undefined;
}

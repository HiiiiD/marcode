export { folderName } from '../client-core/folder-name';
export { formatTokens } from '../client-core/format-tokens';

/** Keeps both ends of a long name, so `codex-11y9upt5` and `codex-kv0xh6vl` stay apart in a narrow pane. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) { return text; }
  const tail = Math.ceil((max - 1) / 2);
  const head = max - 1 - tail;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

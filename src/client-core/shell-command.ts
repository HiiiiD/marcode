/** The command after a leading `!`, or undefined when the text is not a shell line. */
export function parseShellCommand(text: string): string | undefined {
  const t = text.trim();
  if (t.length < 2 || t[0] !== '!') { return undefined; }
  const rest = t.slice(1);
  return /^\s|^!/.test(rest) ? undefined : rest;
}

/**
 * Splits a typed command line into command + args. Quotes group; there are no
 * escape characters, because backslash is a Windows path separator here.
 */
export function splitCommandLine(line: string): { command: string; args: string[] } | { error: string } {
  const parts: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) { quote = undefined; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) { parts.push(current); current = ''; inToken = false; }
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (quote) { return { error: `Unclosed ${quote} quote in the command.` }; }
  if (inToken) { parts.push(current); }
  const [command, ...args] = parts;
  if (!command) { return { error: 'Enter the command that starts the server.' }; }
  return { command, args };
}

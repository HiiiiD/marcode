import { splitCommandLine } from '../../client-core/mcp/split-command';

/** `K=V A="b c"` → a record; a token with no `=` is ignored. A blank line is no pairs. */
export function parsePairs(line: string): { pairs: Record<string, string> } | { error: string } {
  if (line.trim() === '') { return { pairs: {} }; }
  const split = splitCommandLine(line);
  // The only other failure is a line of empty quotes, which holds no pairs.
  if ('error' in split) { return split.error.startsWith('Unclosed') ? { error: 'A quote is never closed.' } : { pairs: {} }; }
  return {
    pairs: Object.fromEntries([split.command, ...split.args].flatMap((tok) => {
      const at = tok.indexOf('=');
      return at > 0 ? [[tok.slice(0, at), tok.slice(at + 1)]] : [];
    })),
  };
}

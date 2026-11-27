export interface PathSide { root: string; sep: '/' | '\\' }

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const json = (s: string): string => JSON.stringify(s).slice(1, -1);
const trimSep = (root: string): string => root.replace(/[\\/]+$/, '');

/**
 * Rewrites a moved agent thread's absolute paths from the source checkout to the target one. The text is a
 * JSONL thread, so every path in it is JSON-escaped: a Windows separator reads as two backslashes there.
 */
export function rewriteThreadPaths(text: string, from: PathSide, to: PathSide): string {
  const fromRoot = trimSep(from.root);
  const forms = from.sep === '\\' ? [json(fromRoot), fromRoot.replace(/\\/g, '/')] : [fromRoot];
  const targetRoot = json(trimSep(to.root));
  const targetSep = json(to.sep);
  // The root, then an optional path tail; a following name character means a different folder that shares the prefix.
  // A tail is separators and name characters only: a JSON escape (`\n`) or a comma starts something else.
  const pattern = new RegExp(`(?:${forms.map(escapeRegExp).join('|')})((?:\\\\\\\\|/)(?:\\\\\\\\|[^"\\s\\\\,])*)?(?![A-Za-z0-9._-])`, from.sep === '\\' ? 'gi' : 'g');
  return text.replace(pattern, (_match, tail: string | undefined) => targetRoot + (tail ?? '').replace(/\\\\|\//g, targetSep));
}

export const SPLIT_MIN_WIDTH = 120;
export const MAX_NATIVE_DIFF_LINES = 120;

export const diffView = (width: number): 'split' | 'unified' => (width >= SPLIT_MIN_WIDTH ? 'split' : 'unified');

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
// Anything between hunks that is not a patch header means the counts understated the body.
const HEADER = /^(?:$|--- |\+\+\+ |diff |index |new file|deleted file|old mode|new mode|similarity|rename |copy |Binary |\\)/;

/** `<diff>` shows a parse error for a hunk whose counts lie, so only well-formed patches reach it. */
export function hunksAreWellFormed(diff: string): boolean {
  let oldLeft = 0;
  let newLeft = 0;
  let hunks = 0;
  for (const line of diff.split('\n')) {
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk) {
      const m = HUNK.exec(line);
      if (m) {
        oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        newLeft = m[2] === undefined ? 1 : Number(m[2]);
        hunks += 1;
      } else if (!HEADER.test(line)) {
        return false;
      }
      continue;
    }
    const c = line[0];
    if (c === '\\') { continue; }
    if (c === '-') { oldLeft -= 1; }
    else if (c === '+') { newLeft -= 1; }
    else if (c === ' ' || line === '') { oldLeft -= 1; newLeft -= 1; }
    else { return false; }
    if (oldLeft < 0 || newLeft < 0) { return false; }
  }
  return hunks > 0 && oldLeft === 0 && newLeft === 0;
}

import type { KeyEvent } from '@opentui/core';

/** The next value of a single-line field after `key`, or undefined when the key is not text editing. */
export function editText(prev: string, key: Pick<KeyEvent, 'name' | 'sequence' | 'ctrl' | 'meta'>): string | undefined {
  if (key.name === 'backspace') { return prev.slice(0, -1); }
  if (key.ctrl || key.meta) { return undefined; }
  const s = key.sequence;
  if (s && [...s].length === 1 && s >= ' ' && s !== '\x7f') { return prev + s; }
  return undefined;
}

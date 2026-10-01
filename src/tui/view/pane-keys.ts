import type { KeyInput } from '../keymap';

export type Dir = 'left' | 'right' | 'up' | 'down';
export type PaneAction =
  | { do: 'focus'; dir: Dir } | { do: 'split'; orientation: 'horizontal' | 'vertical' }
  | { do: 'maximize' } | { do: 'even' } | { do: 'resize'; dir: Dir } | { do: 'hide' };
export interface ChordResult { armedAt: number | null; consumed: boolean; action?: PaneAction }

export const CHORD_MS = 1500;

const FOCUS: Record<string, Dir> = {
  h: 'left', j: 'down', k: 'up', l: 'right', left: 'left', down: 'down', up: 'up', right: 'right',
};
const RESIZE: Record<string, Dir> = { H: 'left', J: 'down', K: 'up', L: 'right' };

function chordAction(key: KeyInput): PaneAction | undefined {
  const glyph = key.sequence ?? key.name;
  if (glyph === '|') { return { do: 'split', orientation: 'horizontal' }; }
  if (glyph === '-') { return { do: 'split', orientation: 'vertical' }; }
  if (glyph === '=') { return { do: 'even' }; }
  const letter = key.shift && key.name.length === 1 ? key.name.toUpperCase() : key.name;
  const resize = RESIZE[letter];
  if (resize) { return { do: 'resize', dir: resize }; }
  if (key.name === 'm') { return { do: 'maximize' }; }
  if (key.name === 'x') { return { do: 'hide' }; }
  const focus = FOCUS[key.name];
  return focus ? { do: 'focus', dir: focus } : undefined;
}

export function chordStep(armedAt: number | null, now: number, key: KeyInput): ChordResult {
  if (key.ctrl === true && key.name === 'w') { return { armedAt: now, consumed: true }; }
  if (armedAt === null || now - armedAt > CHORD_MS) { return { armedAt: null, consumed: false }; }
  const action = chordAction(key);
  return action ? { armedAt: null, consumed: true, action } : { armedAt: null, consumed: true };
}

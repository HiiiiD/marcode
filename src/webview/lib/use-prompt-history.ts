import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * Shell-style recall over `history` (newest first). Starting a walk needs an
 * empty box or a collapsed caret at the very start, so ArrowUp still moves
 * around inside a multi-line draft; once walking, single-line entries answer
 * to both arrows wherever the caret is.
 */
export function usePromptHistory(
  history: readonly string[],
  text: string,
  setText: (text: string) => void,
  box: RefObject<HTMLTextAreaElement | null>,
) {
  const index = useRef(-1);
  const stash = useRef('');
  const caretToEnd = useRef(false);

  useLayoutEffect(() => {
    if (!caretToEnd.current) { return; }
    caretToEnd.current = false;
    box.current?.setSelectionRange(text.length, text.length);
  }, [text, box]);

  const show = (next: number, value: string) => {
    index.current = next;
    caretToEnd.current = true;
    setText(value);
  };

  return {
    reset: () => { index.current = -1; },
    handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return false; }
      if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) { return false; }
      const el = e.currentTarget;
      const walking = index.current >= 0;
      const roaming = walking && !text.includes('\n');

      if (e.key === 'ArrowUp') {
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        if (!(text === '' || atStart || roaming)) { return false; }
        if (index.current + 1 >= history.length) { return walking; }
        if (!walking) { stash.current = text; }
        e.preventDefault();
        show(index.current + 1, history[index.current + 1]);
        return true;
      }

      if (!walking) { return false; }
      const atEnd = el.selectionStart === text.length && el.selectionEnd === text.length;
      if (!(roaming || atEnd)) { return false; }
      e.preventDefault();
      if (index.current === 0) {
        show(-1, stash.current);
      } else {
        show(index.current - 1, history[index.current - 1]);
      }
      return true;
    },
  };
}

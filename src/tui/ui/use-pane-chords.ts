import { useKeyboard } from '@opentui/react';
import { useEffect, useRef } from 'react';
import { visibleRects, neighbour, type Rect } from '../../client-core/pane-geometry';
import { evenAll, nudgeFocused } from '../../client-core/pane-resize';
import { CHORD_MS, chordStep, type PaneAction } from '../view/pane-keys';
import type { PaneLayoutApi } from './use-pane-layout';
import { useTuiStore } from './store';

const HINT = '^W: h j k l focus · | - split · m max · = even · H J K L resize · x hide';
const RESIZE_PCT = 5;

export interface PaneChords {
  area: Rect;
  inert: boolean;
  maximized: boolean;
  layout: PaneLayoutApi;
  onSplit(orientation: 'horizontal' | 'vertical'): void;
  toggleMaximize(): void;
}

export function usePaneChords(c: PaneChords): void {
  const { focusedId, notice, setNotice } = useTuiStore();
  const armed = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  useEffect(() => () => { clearTimeout(timer.current); }, []);

  const disarm = () => {
    armed.current = null;
    clearTimeout(timer.current);
    if (noticeRef.current === HINT) { setNotice(null); }
  };

  const run = (action: PaneAction) => {
    if (!focusedId) { return; }
    const { layout } = c;
    switch (action.do) {
      case 'focus': {
        const target = neighbour(visibleRects(layout.root, focusedId, c.area, c.maximized).panes, focusedId, action.dir);
        if (target) { layout.placeOrFocus(target); }
        return;
      }
      case 'split': c.onSplit(action.orientation); return;
      case 'maximize': c.toggleMaximize(); return;
      case 'even': layout.applyRoot(evenAll(layout.root)); return;
      case 'resize': layout.applyRoot(nudgeFocused(layout.root, focusedId, action.dir, RESIZE_PCT)); return;
      case 'hide': layout.hide(focusedId); return;
    }
  };

  useKeyboard((key) => {
    if (c.inert) { return; }
    const step = chordStep(armed.current, Date.now(), key);
    if (!step.consumed) { armed.current = null; return; }
    key.preventDefault();
    armed.current = step.armedAt;
    if (step.armedAt !== null) {
      setNotice(HINT);
      clearTimeout(timer.current);
      timer.current = setTimeout(disarm, CHORD_MS);
      return;
    }
    disarm();
    if (step.action) { run(step.action); }
  });
}

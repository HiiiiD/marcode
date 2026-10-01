import { useKeyboard } from '@opentui/react';
import { useEffect, useRef } from 'react';
import type { SessionSummary } from '../../protocol/messages';
import { actionFor, type Zone } from '../keymap';
import type { PickerKind } from '../view/pickers';
import { useTuiStore } from './store';

export const QUIT_NOTICE = 'Press Ctrl+C again to quit';

export interface AppKeys {
  inert: boolean;
  zone: Zone;
  summary: SessionSummary | undefined;
  quitWindowMs: number;
  onQuit(): void;
  toggleRoster(): void;
  openDialog(): void;
  openPicker(kind: PickerKind): void;
  cycleZone(): void;
}

export function useAppKeys(k: AppKeys): void {
  const { post, notice, setNotice, mentionOpen, rosterFiltering } = useTuiStore();
  const armed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const noticeRef = useRef(notice);
  noticeRef.current = notice;

  useEffect(() => () => { clearTimeout(armed.current); }, []);

  const quitArmed = () => armed.current !== undefined;
  const quitRequest = () => {
    if (quitArmed()) {
      clearTimeout(armed.current);
      armed.current = undefined;
      k.onQuit();
      return;
    }
    setNotice(QUIT_NOTICE);
    armed.current = setTimeout(() => {
      armed.current = undefined;
      if (noticeRef.current === QUIT_NOTICE) { setNotice(null); }
    }, k.quitWindowMs);
  };

  // send/newline/history belong to the composer's own textarea bindings; acting on them here would send twice.
  useKeyboard((key) => {
    if (k.inert || key.defaultPrevented) { return; }
    // A popup or the roster filter owns Esc and Tab while open; Esc must not also interrupt the turn.
    if (key.name === 'tab' && ((mentionOpen && !key.shift) || rosterFiltering)) { return; }
    if (key.name === 'escape' && (mentionOpen || rosterFiltering)) { return; }
    // A foreign session is read-only here: no interrupt and no model/effort/mode switch may be posted for it.
    const s = k.summary && !k.summary.owner ? k.summary : undefined;
    const busy = s?.status === 'running' || s?.status === 'awaiting-approval';
    const action = actionFor(k.zone, key, { running: busy });
    switch (action?.do) {
      case 'toggle-roster': k.toggleRoster(); return;
      case 'new-session': k.openDialog(); return;
      case 'cycle-zone': k.cycleZone(); return;
      case 'interrupt': {
        if (!s) { return; }
        // The second Ctrl+C quits even mid-turn, so a provider that never stops cannot trap the user.
        if (key.ctrl) {
          if (quitArmed()) { quitRequest(); return; }
          post({ t: 'interrupt', id: s.id });
          quitRequest();
          return;
        }
        const interrupt = () => { post({ t: 'interrupt', id: s.id }); };
        // Prompts subscribe after App, so they see this Esc later; one that uses it (leaving a text entry) marks it.
        if (key.name === 'escape' && (k.zone === 'approval' || k.zone === 'question')) {
          queueMicrotask(() => { if (!key.defaultPrevented) { interrupt(); } });
        } else { interrupt(); }
        return;
      }
      case 'quit-request': quitRequest(); return;
      case 'refresh-catalog': post({ t: 'refresh-catalog' }); return;
      case 'open-model': if (s) { k.openPicker('model'); } return;
      case 'open-effort': if (s) { k.openPicker('effort'); } return;
      case 'open-mode': if (s) { k.openPicker('mode'); } return;
      default: return;
    }
  });
}

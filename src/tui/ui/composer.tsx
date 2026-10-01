import { useKeyboard } from '@opentui/react';
import type { KeyBinding, TextareaRenderable } from '@opentui/core';
import { useEffect, useMemo, useRef } from 'react';
import { promptHistory } from '../../client-core/prompt-history';
import type { SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { useTuiStore } from './store';

const DEBOUNCE_MS = 300;

// The textarea defaults Enter to newline and Alt+Enter to submit; flip both, and keep linefeed (Ctrl+J) a newline.
const KEY_BINDINGS: KeyBinding[] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'kpenter', meta: true, action: 'newline' },
  { name: 'linefeed', action: 'newline' },
];

export function Composer({ sessionId, focused }: { sessionId: SessionId; focused: boolean }) {
  const { state, post, drafts } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const queued = pane?.summary.queued ?? [];
  const history = useMemo(() => promptHistory(pane?.items ?? []), [pane?.items]);
  const box = useRef<TextareaRenderable | null>(null);
  const walk = useRef(-1);
  const programmatic = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | null>(null);

  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current === null) { return; }
    post({ t: 'set-draft', id: sessionId, text: pending.current });
    pending.current = null;
  };

  const setBox = (text: string) => {
    programmatic.current = text;
    box.current?.setText(text);
    box.current?.gotoBufferEnd();
  };

  useEffect(() => {
    const seed = drafts.get(sessionId);
    if (seed !== '' && box.current && box.current.plainText !== seed) { setBox(seed); }
    return drafts.subscribe(sessionId, () => {
      const next = drafts.get(sessionId);
      if (box.current && box.current.plainText !== next) { setBox(next); }
    });
  }, [drafts, sessionId]);

  useEffect(() => flush, [sessionId]);

  const onContentChange = () => {
    const text = box.current?.plainText ?? '';
    if (programmatic.current === text) { programmatic.current = null; } else { walk.current = -1; }
    drafts.set(sessionId, text);
    pending.current = text;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };

  const submit = () => {
    const value = (box.current?.plainText ?? '').trim();
    if (value === '') { return; }
    post({ t: 'send', id: sessionId, text: value });
    walk.current = -1;
    setBox('');
    drafts.set(sessionId, '');
    pending.current = '';
    flush();
  };

  useKeyboard((key) => {
    if (!focused) { return; }
    if (actionFor('composer', key, { running })?.do !== 'history-prev' || history.length === 0) { return; }
    const text = box.current?.plainText ?? '';
    const atStart = text === '' || box.current?.cursorOffset === 0;
    if (!atStart && !(walk.current >= 0 && box.current?.logicalCursor.row === 0)) { return; }
    walk.current = Math.min(walk.current + 1, history.length - 1);
    setBox(history[walk.current]);
  });

  return (
    <box flexDirection="column">
      {queued.map((q) => <text key={q.id} fg="gray">{`queued: ${q.text}`}</text>)}
      <box border borderStyle="single">
        <textarea
          ref={box}
          focused={focused}
          keyBindings={KEY_BINDINGS}
          placeholder={running ? 'Working… Esc to interrupt' : 'Message — Enter send, Ctrl+J newline'}
          onContentChange={onContentChange}
          onSubmit={submit}
          height={3}
        />
      </box>
    </box>
  );
}

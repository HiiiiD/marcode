import { useKeyboard } from '@opentui/react';
import type { KeyBinding, TextareaRenderable } from '@opentui/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAttachCommand, parsePastedPaths } from '../../client-core/path-paste';
import { promptHistory } from '../../client-core/prompt-history';
import type { SessionId } from '../../protocol/messages';
import { existingFileUris } from '../attach-paths';
import { actionFor } from '../keymap';
import { AttachmentChips } from './attachment-chips';
import { MentionPopup } from './mention-popup';
import { useTuiStore } from './store';
import { useMentionPopup } from './use-mention-popup';

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
  const { state, post, drafts, setMentionOpen, setNotice } = useTuiStore();
  const pane = state.byId[sessionId];
  const running = pane?.summary.status === 'running';
  const queued = pane?.summary.queued ?? [];
  const attachments = pane?.attachments ?? [];
  const rejected = state.rejectionBySession[sessionId] ?? [];
  const history = useMemo(() => promptHistory(pane?.items ?? []), [pane?.items]);
  const box = useRef<TextareaRenderable | null>(null);
  const walk = useRef(-1);
  const programmatic = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | null>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const popup = useMentionPopup({ sessionId, text, caret });
  useEffect(() => { setMentionOpen(popup.open); return () => { setMentionOpen(false); }; }, [popup.open]);

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
    setText(text);
    setCaret(text.length);
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
    const value = box.current?.plainText ?? '';
    setText(value);
    setCaret(box.current?.cursorOffset ?? value.length);
    if (programmatic.current === value) { programmatic.current = null; } else { walk.current = -1; }
    drafts.set(sessionId, value);
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };

  const attach = (paths: string[]): boolean => {
    const uris = existingFileUris(paths);
    if (!uris) { return false; }
    post({ t: 'attach-drop', id: sessionId, uris });
    return true;
  };

  const submit = () => {
    const value = (box.current?.plainText ?? '').trim();
    if (value === '') { return; }
    const command = parseAttachCommand(value);
    if (command !== undefined) {
      if (!attach(command)) { setNotice('attach: path not found or not an absolute file path'); return; }
      setBox('');
      drafts.set(sessionId, '');
      pending.current = '';
      flush();
      return;
    }
    popup.prune(value);
    const fileRefs = popup.refs();
    post({ t: 'send', id: sessionId, text: value, ...(fileRefs.length > 0 ? { fileRefs } : {}) });
    walk.current = -1;
    setBox('');
    drafts.set(sessionId, '');
    pending.current = '';
    flush();
  };

  useKeyboard((key) => {
    if (!focused) { return; }
    if (popup.open) {
      if (key.name === 'escape') { popup.dismiss(); key.preventDefault(); return; }
      if (key.name === 'down') { popup.move(1); key.preventDefault(); return; }
      if (key.name === 'up') { popup.move(-1); key.preventDefault(); return; }
      if (key.name === 'tab' || key.name === 'return') {
        const next = popup.pick();
        if (next) { setBox(next.text); key.preventDefault(); }
        return;
      }
    }
    if (actionFor('composer', key, { running })?.do === 'attach-remove') {
      const last = attachments.at(-1);
      if (last) { post({ t: 'attach-remove', id: sessionId, attachmentId: last.id }); }
      return;
    }
    if (actionFor('composer', key, { running })?.do !== 'history-prev' || history.length === 0) { return; }
    const text = box.current?.plainText ?? '';
    const atStart = text === '' || box.current?.cursorOffset === 0;
    if (!atStart && !(walk.current >= 0 && box.current?.logicalCursor.row === 0)) { return; }
    walk.current = Math.min(walk.current + 1, history.length - 1);
    setBox(history[walk.current]);
  });

  return (
    <box flexDirection="column">
      {popup.open ? <MentionPopup rows={popup.rows} index={popup.index} /> : null}
      <AttachmentChips attachments={attachments} rejected={rejected} />
      {queued.map((q) => <text key={q.id} fg="gray">{`queued: ${q.text}`}</text>)}
      <box border borderStyle="single">
        <textarea
          ref={box}
          focused={focused}
          keyBindings={KEY_BINDINGS}
          placeholder={running ? 'Working… Esc to interrupt' : 'Message — Enter send, Ctrl+J newline'}
          onContentChange={onContentChange}
          onPaste={(event) => {
            const paths = parsePastedPaths(new TextDecoder().decode(event.bytes));
            if (paths.length > 0 && attach(paths)) { event.preventDefault(); }
          }}
          onSubmit={() => { if (!popup.open) { submit(); } }}
          height={3}
        />
      </box>
    </box>
  );
}

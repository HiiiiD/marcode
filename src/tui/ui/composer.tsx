import { useKeyboard } from '@opentui/react';
import type { KeyBinding, TextareaRenderable } from '@opentui/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseAttachCommand, parsePastedPaths } from '../../client-core/path-paste';
import { parseShellCommand } from '../../client-core/shell-command';
import { promptHistory } from '../../client-core/prompt-history';
import type { SessionId } from '../../protocol/messages';
import { existingFileUris } from '../attach-paths';
import { readClipboardImage } from '../clipboard-image';
import { parsePickerCommand, type PickerKind } from '../view/pickers';
import { actionFor } from '../keymap';
import { AttachmentChips } from './attachment-chips';
import { InvocablePopup } from './invocable-popup';
import { MentionPopup } from './mention-popup';
import { useTuiStore } from './store';
import { Surface } from './surface';
import { useTokens } from './tokens/tokens-provider';
import { useInvocablePopup } from './use-invocable-popup';
import { useMentionPopup } from './use-mention-popup';

const DEBOUNCE_MS = 300;

// The textarea defaults Enter to newline and Alt+Enter to submit; flip both, and keep linefeed (Ctrl+J) a newline,
// and make Ctrl+A select everything rather than the emacs line-home (Home still goes there).
const KEY_BINDINGS: KeyBinding[] = [
  { name: 'return', action: 'submit' },
  { name: 'kpenter', action: 'submit' },
  { name: 'return', meta: true, action: 'newline' },
  { name: 'kpenter', meta: true, action: 'newline' },
  { name: 'linefeed', action: 'newline' },
  { name: 'a', ctrl: true, action: 'select-all' },
];

export function Composer({ sessionId, focused, onOpenPicker }: { sessionId: SessionId; focused: boolean; onOpenPicker?: (kind: PickerKind) => void }) {
  const { state, post, drafts, setMentionOpen, setNotice, dismissRejection } = useTuiStore();
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
  const tokens = useTokens();
  const shellMode = parseShellCommand(text) !== undefined;
  const popup = useMentionPopup({ sessionId, text: shellMode ? '' : text, caret });
  const slash = useInvocablePopup({ sessionId, text: shellMode ? '' : text });
  const anyOpen = popup.open || slash.open;
  useEffect(() => { setMentionOpen(anyOpen); return () => { setMentionOpen(false); }; }, [anyOpen]);

  const flush = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current === null) { return; }
    post({ t: 'set-draft', id: sessionId, text: pending.current });
    pending.current = null;
  };

  const setBox = (text: string, at: number = text.length) => {
    programmatic.current = text;
    box.current?.setText(text);
    if (at >= text.length) { box.current?.gotoBufferEnd(); } else if (box.current) { box.current.cursorOffset = at; }
    setText(text);
    setCaret(at);
  };
  // Recalled and restored text is not something the user is mid-way through typing, so an `@` at its end stays closed.
  const setBoxQuiet = (text: string) => { popup.suppress(text); slash.suppress(text); setBox(text); };

  useEffect(() => {
    const seed = drafts.get(sessionId);
    if (box.current && box.current.plainText !== seed) { setBoxQuiet(seed); }
    return drafts.subscribe(sessionId, () => {
      const next = drafts.get(sessionId);
      if (box.current && box.current.plainText !== next) { setBoxQuiet(next); }
    });
  }, [drafts, sessionId]);

  useEffect(() => flush, [sessionId]);

  const onContentChange = () => {
    const value = box.current?.plainText ?? '';
    setText(value);
    setCaret(box.current?.cursorOffset ?? value.length);
    if (programmatic.current === value) { programmatic.current = null; } else {
      walk.current = -1;
      if (rejected.length > 0) { dismissRejection(sessionId); }
    }
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

  const attachClipboardImage = async (quiet: boolean) => {
    const img = await readClipboardImage();
    if (img.kind === 'image') { post({ t: 'attach-paste', id: sessionId, mediaType: img.mediaType, base64: img.base64 }); return; }
    if (quiet) { return; }
    setNotice(img.kind === 'none' ? 'clipboard has no image' : `clipboard image: ${img.hint}`);
  };

  const submit = () => {
    const value = (box.current?.plainText ?? '').trim();
    if (value === '') { return; }
    const shell = parseShellCommand(value);
    if (shell !== undefined) {
      post({ t: 'run-shell', id: sessionId, command: shell });
      setBox('');
      drafts.set(sessionId, '');
      pending.current = '';
      flush();
      return;
    }
    const picker = parsePickerCommand(value);
    if (picker && onOpenPicker) {
      setBox('');
      drafts.set(sessionId, '');
      pending.current = '';
      flush();
      onOpenPicker(picker);
      return;
    }
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
    popup.reset();
    walk.current = -1;
    setBox('');
    drafts.set(sessionId, '');
    pending.current = '';
    flush();
  };

  useKeyboard((key) => {
    if (!focused) { return; }
    if (slash.open) {
      if (key.name === 'escape') { slash.dismiss(); key.preventDefault(); return; }
      if (key.name === 'down') { slash.move(1); key.preventDefault(); return; }
      if (key.name === 'up') { slash.move(-1); key.preventDefault(); return; }
      if (key.name === 'tab' || key.name === 'return') {
        const next = slash.pick();
        if (next) { setBox(next.text, next.caret); key.preventDefault(); }
        return;
      }
    }
    if (popup.open) {
      if (key.name === 'escape') { popup.dismiss(); key.preventDefault(); return; }
      if (key.name === 'down') { popup.move(1); key.preventDefault(); return; }
      if (key.name === 'up') { popup.move(-1); key.preventDefault(); return; }
      if (key.name === 'tab' || key.name === 'return') {
        const next = popup.pick();
        if (next) { setBox(next.text, next.caret); key.preventDefault(); }
        return;
      }
    }
    if (actionFor('composer', key, { running })?.do === 'attach-clipboard') { key.preventDefault(); void attachClipboardImage(false); return; }
    if (actionFor('composer', key, { running })?.do === 'attach-open') {
      key.preventDefault();
      const last = attachments.at(-1);
      if (last) { post({ t: 'open-attachment', id: sessionId, attachmentId: last.id }); }
      return;
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
    setBoxQuiet(history[walk.current]);
  });

  return (
    <box flexDirection="column">
      {popup.open ? <MentionPopup rows={popup.rows} index={popup.index} /> : null}
      {slash.open ? <InvocablePopup rows={slash.rows} overflow={slash.overflow} index={slash.index} /> : null}
      <AttachmentChips attachments={attachments} rejected={rejected} onOpen={(a) => { post({ t: 'open-attachment', id: sessionId, attachmentId: a.id }); }} />
      {shellMode ? <text fg={tokens?.textMuted ?? 'gray'}>shell command: Enter runs it here, nothing goes to the model</text> : null}
      {queued.map((q) => <text key={q.id} fg={tokens?.textMuted ?? 'gray'}>{`queued: ${q.text}`}</text>)}
      <Surface tone="panel" padX={1} padY={1}>
        <textarea
          ref={box}
          focused={focused}
          keyBindings={KEY_BINDINGS}
          placeholder={running ? 'Working… Esc to interrupt' : 'Message — Enter send, Ctrl+J newline'}
          onContentChange={onContentChange}
          onCursorChange={() => { setCaret(box.current?.cursorOffset ?? 0); }}
          onPaste={(event) => {
            const pasted = new TextDecoder().decode(event.bytes);
            // A terminal pastes an empty string when the clipboard holds only an image.
            if (pasted === '') { void attachClipboardImage(true); return; }
            const paths = parsePastedPaths(pasted);
            if (paths.length > 0 && attach(paths)) { event.preventDefault(); }
          }}
          onSubmit={() => { if (!anyOpen) { submit(); } }}
          height={tokens ? Math.min(5, Math.max(1, text.split('\n').length)) : 3}
          {...(tokens ? { backgroundColor: tokens.panel, focusedBackgroundColor: tokens.panel, placeholderColor: tokens.textMuted } : {})}
        />
      </Surface>
    </box>
  );
}

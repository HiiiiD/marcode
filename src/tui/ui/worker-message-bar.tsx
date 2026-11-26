import { useKeyboard } from '@opentui/react';
import type { TextareaRenderable } from '@opentui/core';
import { useEffect, useRef, useState } from 'react';
import { KEY_BINDINGS } from './composer';
import { useTuiStore, type WorkerTarget } from './store';
import { Surface } from './surface';
import { useTheme } from './termcn/hooks/use-theme';
import { useTokens } from './tokens/tokens-provider';

/**
 * One message to a hosted worker, in place of the pane's composer: its own box, so nothing typed here becomes the
 * parent's draft. Esc goes back to the composer.
 */
export function WorkerMessageBar({ target, focused }: { target: WorkerTarget; focused: boolean }) {
  const { post, setNotice, setMentionOpen, setWorkerTarget } = useTuiStore();
  const theme = useTheme();
  const tokens = useTokens();
  const box = useRef<TextareaRenderable | null>(null);
  const [lines, setLines] = useState(1);

  // Owns Esc and Tab while open, the way a popup does, so Esc never interrupts the parent's turn.
  useEffect(() => { setMentionOpen(true); return () => { setMentionOpen(false); }; }, []);

  useKeyboard((key) => {
    if (!focused || key.name !== 'escape') { return; }
    key.preventDefault();
    setWorkerTarget(null);
  });

  const submit = () => {
    const text = (box.current?.plainText ?? '').trim();
    if (text === '') { return; }
    post({ t: 'send', id: target.workerId, text });
    setNotice(`Sent to ${target.name}`);
    setWorkerTarget(null);
  };

  const muted = tokens?.textMuted ?? theme.colors.mutedForeground;
  return (
    <box flexDirection="column">
      <text fg={muted} wrapMode="none">
        <span fg={theme.colors.primary}>{`To ${target.name}`}</span>
        {` · ${target.running ? 'it reads this after its current turn' : 'starts a new turn for this worker'} · Esc back`}
      </text>
      <Surface tone="panel" padX={1} padY={1}>
        <textarea
          ref={box}
          focused={focused}
          keyBindings={KEY_BINDINGS}
          placeholder={`Message ${target.name} — Enter send`}
          onContentChange={() => { setLines((box.current?.plainText ?? '').split('\n').length); }}
          onSubmit={submit}
          height={tokens ? Math.min(5, Math.max(1, lines)) : 3}
          {...(tokens ? { backgroundColor: tokens.panel, focusedBackgroundColor: tokens.panel, placeholderColor: tokens.textMuted } : {})}
        />
      </Surface>
    </box>
  );
}

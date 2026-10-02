import { useKeyboard } from '@opentui/react';
import { useEffect, useRef } from 'react';
import { contextModel, fitPath, headerLabel, stackedBar, type SliceKey } from '../../client-core/context-format';
import type { SessionId } from '../../protocol/messages';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';

const BAR_WIDTH = 40;
const PERCENT_COL = 5;
const GLYPH: Record<SliceKey, string> = { system: '█', memory: '▓', conversation: '▒', free: '░' };
const COLOR: Record<SliceKey, string> = { system: 'cyan', memory: 'blue', conversation: 'white', free: 'gray' };

export function ContextDialog({ sessionId, onClose }: { sessionId: SessionId; onClose(): void }) {
  const { state, post } = useTuiStore();
  const summary = state.byId[sessionId]?.summary ?? state.sessions.find((s) => s.id === sessionId);
  const result = state.contextBySession[sessionId];
  const present = summary !== undefined && state.sessions.some((x) => x.id === sessionId);
  const seen = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const postRef = useRef(post);
  postRef.current = post;

  useEffect(() => { postRef.current({ t: 'request-context', id: sessionId }); }, [sessionId]);
  // Only a session that was here and left closes it; before hydrate nothing has been here yet.
  useEffect(() => {
    if (present) { seen.current = true; } else if (seen.current) { closeRef.current(); }
  }, [present]);

  useKeyboard((key) => {
    if (key.name === 'escape') { onClose(); return; }
    if (key.name === 'r' && result?.ok === false) { post({ t: 'request-context', id: sessionId }); }
  });

  if (!summary || !present) { return null; }
  const header = headerLabel(summary.contextPercent);
  const model = result?.ok ? contextModel(result.breakdown) : undefined;
  const pathWidth = BAR_WIDTH - PERCENT_COL - 2;
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Context">
        <text fg={header.danger ? 'red' : 'gray'}>{header.text}</text>
        {!result ? <text fg="gray">Loading…</text> : null}
        {result && !result.ok ? <text fg="gray">{`${result.reason}   r retry`}</text> : null}
        {model ? (
          <>
            <text>
              {stackedBar(model.slices, BAR_WIDTH).map((c) => (
                <span key={c.key} fg={COLOR[c.key]}>{GLYPH[c.key].repeat(c.cells)}</span>
              ))}
            </text>
            {model.window ? <text fg="gray">{model.window.padStart(BAR_WIDTH)}</text> : null}
            {model.slices.map((s) => (
              <box key={s.key} flexDirection="column">
                <text>{`${s.label.padEnd(BAR_WIDTH - PERCENT_COL)}${`${s.percent}%`.padStart(PERCENT_COL)}`}</text>
                {s.key === 'memory' && model.memoryFiles.length === 0 ? <text fg="gray">  No memory files loaded</text> : null}
                {s.key === 'memory' ? model.memoryFiles.map((f) => (
                  <text key={f.path} fg="gray">
                    {`  ${fitPath(f.path, pathWidth).padEnd(pathWidth)}${f.percent.padStart(PERCENT_COL)}`}
                  </text>
                )) : null}
              </box>
            ))}
          </>
        ) : null}
        <text fg="gray">Esc close</text>
      </Dialog>
    </box>
  );
}

import { useKeyboard } from '@opentui/react';
import { useRef } from 'react';
import { MAX_GRID_DIM, planGrid, planShape, type LayoutPlan } from '../../client-core/layout-apply';
import { leafSessionIds, type LayoutNode } from '../../client-core/layout-tree';
import { gridPreview, initialDims, overflowNotice, presetRows, sessionTitles } from '../view/layout-rows';
import { windowAround } from '../view/pickers';
import { useTuiStore } from './store';
import { Dialog } from './termcn/components/ui/dialog';
import { useSyncState } from './use-sync-state';

const LIST_ROWS = 8;
const MAX_NAME = 40;
const FIRST_PRESET = 2;

interface DialogState {
  index: number;
  rows: number;
  cols: number;
  mode: 'list' | 'confirm' | 'name';
  name: string;
  error?: string;
  pending?: { plan: LayoutPlan; label: string };
}

export function LayoutDialog({ onApply, onClose }: { onApply(root: LayoutNode): void; onClose(): void }) {
  const { state, post } = useTuiStore();
  const openIds = leafSessionIds(state.layout.root);
  const presets = presetRows(state.layout.root, state.layout.presets);
  const last = FIRST_PRESET + presets.length - 1;
  const st = useSyncState<DialogState>({ index: 0, ...initialDims(state.layout.root), mode: 'list', name: '' });
  const sent = useRef(false);

  const apply = (root: LayoutNode) => {
    sent.current = true;
    onApply(root);
    onClose();
  };

  useKeyboard((key) => {
    if (sent.current) { return; }
    const cur = st.get();
    const index = Math.min(cur.index, last);

    if (cur.mode === 'name') {
      if (key.name === 'escape') { st.set({ mode: 'list', name: '', error: undefined }); }
      else if (key.name === 'return') {
        const name = cur.name.trim();
        if (name === '') { st.set({ error: 'Name cannot be empty' }); return; }
        post({ t: 'save-preset', name });
        st.set({ mode: 'list', name: '', error: undefined });
      } else if (key.name === 'backspace') { st.set({ name: cur.name.slice(0, -1), error: undefined }); }
      else if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && !key.ctrl && !key.meta && cur.name.length < MAX_NAME) {
        st.set({ name: cur.name + key.sequence, error: undefined });
      }
      return;
    }

    if (cur.mode === 'confirm') {
      if (key.name === 'escape') { st.set({ mode: 'list', pending: undefined }); }
      else if (key.name === 'return' && cur.pending) { apply(cur.pending.plan.root); }
      return;
    }

    if (key.name === 'escape') { onClose(); return; }
    if (key.ctrl || key.meta) { return; }
    if (key.name === 'down') { st.set({ index: Math.min(last, index + 1) }); return; }
    if (key.name === 'up') { st.set({ index: Math.max(0, index - 1) }); return; }
    if (key.name === 's') { st.set({ mode: 'name', name: '', error: undefined }); return; }
    const row = index >= FIRST_PRESET ? presets[index - FIRST_PRESET] : undefined;
    if (key.name === 'd') {
      if (row?.kind === 'saved') { post({ t: 'delete-preset', id: row.preset.id }); }
      return;
    }
    if ((key.name === 'left' || key.name === 'right') && index < FIRST_PRESET) {
      const step = key.name === 'right' ? 1 : -1;
      const field = index === 0 ? 'rows' : 'cols';
      st.set({ [field]: Math.min(MAX_GRID_DIM, Math.max(1, cur[field] + step)) });
      return;
    }
    if (key.name === 'return') {
      if (index >= FIRST_PRESET && !row) { return; }
      const plan = row ? planShape(row.preset.root, openIds) : planGrid(cur.rows, cur.cols, openIds);
      if (plan.hidden.length === 0) { apply(plan.root); return; }
      st.set({ mode: 'confirm', pending: { plan, label: row ? row.preset.name : `${cur.rows}x${cur.cols} grid` } });
    }
  });

  const view = st.view;
  const index = Math.min(view.index, last);
  const { start, end } = windowAround(presets.length, Math.max(0, index - FIRST_PRESET), LIST_ROWS);
  const marker = (i: number) => (i === index ? '›' : ' ');
  return (
    <box flexDirection="column" flexShrink={0}>
      <Dialog isOpen interactive={false} title="Layout">
        <text attributes={index === 0 ? 1 : 0}>{`${marker(0)} Rows     ‹ ${view.rows} ›`}</text>
        <text attributes={index === 1 ? 1 : 0}>{`${marker(1)} Columns  ‹ ${view.cols} ›`}</text>
        {gridPreview(view.rows, view.cols, openIds.length).map((line, i) => <text key={i} fg="gray">{`    ${line}`}</text>)}
        {presets.slice(start, end).map((row, offset) => {
          const i = start + offset;
          const heading = i === start || presets[i - 1].kind !== row.kind;
          return (
            <box key={row.preset.id} flexDirection="column">
              {heading ? <text fg="gray">{row.kind === 'builtin' ? 'Built-in' : 'Saved'}</text> : null}
              <text attributes={index === i + FIRST_PRESET ? 1 : 0}>{`${marker(i + FIRST_PRESET)} ${row.active ? '✓' : ' '} ${row.preset.name}`}</text>
            </box>
          );
        })}
        {view.mode === 'confirm' && view.pending ? (
          <box flexDirection="column">
            <text fg="yellow">{overflowNotice(sessionTitles(view.pending.plan.hidden, state.sessions))}</text>
            <text>{`Apply ${view.pending.label}?`}</text>
          </box>
        ) : null}
        {view.mode === 'name' ? <text>{`Save current layout as: ${view.name}▏`}</text> : null}
        {view.error ? <text fg="red">{view.error}</text> : null}
        <text fg="gray">
          {view.mode === 'name' ? 'Enter save, Esc cancel'
            : view.mode === 'confirm' ? 'Enter apply anyway, Esc back'
              : 'Up/Down move — Left/Right grid — Enter apply — s save — d delete — Esc close'}
        </text>
      </Dialog>
    </box>
  );
}

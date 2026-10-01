import { useKeyboard } from '@opentui/react';
import { afterEach, expect, test } from 'bun:test';
import type { LayoutPreset } from '../../protocol/messages';
import { useTuiStore } from '../../tui/ui/store';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe() {
  const { focus, focusedId } = useTuiStore();
  useKeyboard((k) => { if (k.name === 'f') { focus('b'); } });
  return <text>{`focused:${focusedId ?? 'none'}`}</text>;
}

const presets: LayoutPreset[] = [
  { id: 'p1', name: 'one', builtin: false, root: { kind: 'leaf', sessionId: 'a', size: 100 } },
];

test('focus posts set-layout, set-visible, focus-pane in order and updates focusedId', async () => {
  m = await mount(<Probe />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('a'), summary('b')],
    snapshots: [snapshot('a')],
    layout: { root: { kind: 'leaf', sessionId: 'a', size: 100 }, presets },
  }));
  expect(m.frame()).toContain('focused:none');
  const before = m.posted.length;
  await m.press('f');
  const after = m.posted.slice(before);
  expect(after.map((p) => p.t)).toEqual(['set-layout', 'set-visible', 'focus-pane']);
  const [layoutMsg, visible, pane] = after;
  if (layoutMsg.t !== 'set-layout' || visible.t !== 'set-visible' || pane.t !== 'focus-pane') { throw new Error('unexpected messages'); }
  const layout = layoutMsg.layout; const rootNode = layout.root;
  expect(rootNode).toEqual({ kind: 'leaf', sessionId: 'b', size: 100 });
  expect(layoutMsg.layout.focusedSessionId).toBe('b');
  expect(layoutMsg.layout.presets).toEqual(presets);
  expect(visible.sessionIds).toEqual(['b']);
  expect(pane.sessionId).toBe('b');
  expect(m.frame()).toContain('focused:b');
});

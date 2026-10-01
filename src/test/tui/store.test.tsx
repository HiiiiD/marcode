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

test('focus posts only focus-pane and updates focusedId; the layout is not rewritten', async () => {
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
  expect(after.map((p) => p.t)).toEqual(['focus-pane']);
  const [pane] = after;
  if (pane.t !== 'focus-pane') { throw new Error('unexpected messages'); }
  expect(pane.sessionId).toBe('b');
  expect(m.frame()).toContain('focused:b');
});

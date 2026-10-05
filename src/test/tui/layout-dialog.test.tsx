import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { HostToWebview, LayoutNode, LayoutPreset, PaneLayout } from '../../protocol/messages';
import { gridLayout } from '../../client-core/layout-tree';
import { LayoutDialog } from '../../tui/ui/layout-dialog';
import { useTuiStore } from '../../tui/ui/store';
import { layoutOf, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };

const sessionsOf = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const hydrateWith = (layout: PaneLayout, count: number): HostToWebview => hydrateMsg({
  sessions: sessionsOf(count).map((id) => summary(id)),
  snapshots: sessionsOf(count).map((id) => snapshot(id)),
  layout,
});
const mine = (id: string, name: string): LayoutPreset => ({
  id, name, builtin: false, root: { kind: 'split', orientation: 'vertical', size: 100, children: [
    { kind: 'leaf', sessionId: null, size: 50 }, { kind: 'leaf', sessionId: null, size: 50 }] },
});

// App opens the dialog only after hydrate; mounting it earlier would seed the steppers from an empty layout.
function AfterHydrate({ children }: { children: React.ReactNode }) {
  const { state } = useTuiStore();
  return state.ready ? <>{children}</> : null;
}

interface Probe { applied: LayoutNode[]; closed: number }
const open = async (msg: HostToWebview): Promise<Probe> => {
  const probe: Probe = { applied: [], closed: 0 };
  m = await mount(
    <AfterHydrate><LayoutDialog onApply={(root) => { probe.applied.push(root); }} onClose={() => { probe.closed++; }} /></AfterHydrate>,
    { width: 100, height: 50 },
  );
  await m.fromHost(msg);
  return probe;
};
const posts = (t: 'save-preset' | 'delete-preset') => (m?.posted ?? []).filter((p) => p.t === t);
const leafCount = (n: LayoutNode): number => (n.kind === 'leaf' ? 1 : n.children.reduce((a, c) => a + leafCount(c), 0));

test('lists the grid steppers, a preview, and the built-in presets with the active one marked', async () => {
  await open(hydrateWith(layoutOf(['s1', 's2'], 'horizontal'), 2));
  const frame = m!.frame();
  expect(frame).toContain('Layout');
  expect(frame).toContain('Rows');
  expect(frame).toContain('Columns');
  expect(frame).toContain('[■][■]');
  expect(frame).toContain('✓ 2 columns');
  expect(frame.includes('✓ 2 rows')).toBe(false);
});

test('the steppers start from the current grid and stop at 1 and 6', async () => {
  await open(hydrateWith({ root: gridLayout(2, 3, sessionsOf(6)).root, presets: [] }, 6));
  expect(m!.frame()).toContain('Rows     ‹ 2 ›');
  expect(m!.frame()).toContain('Columns  ‹ 3 ›');
  await m!.pressMany(['right', 'right', 'right', 'right', 'right']);
  expect(m!.frame()).toContain('Rows     ‹ 6 ›');
  await m!.pressMany(['left', 'left', 'left', 'left', 'left', 'left', 'left']);
  expect(m!.frame()).toContain('Rows     ‹ 1 ›');
});

test('Enter on the Rows row applies the dialled grid and closes', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2'], 'horizontal'), 2));
  await m!.press('right');
  await m!.press('return');
  expect(probe.applied.length).toBe(1);
  expect(leafCount(probe.applied[0])).toBe(4);
  expect(probe.closed).toBe(1);
});

test('Enter on a built-in preset applies that shape', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.pressMany(['down', 'down', 'return']);
  expect(leafCount(probe.applied[0])).toBe(2);
  expect(probe.applied[0].kind === 'split' && probe.applied[0].orientation).toBe('vertical');
});

test('a non-grid current tree starts the steppers at 1x2', async () => {
  const asym: PaneLayout = { root: { kind: 'split', orientation: 'horizontal', size: 100, children: [
    { kind: 'leaf', sessionId: 's1', size: 50 },
    { kind: 'split', orientation: 'vertical', size: 50, children: [
      { kind: 'leaf', sessionId: 's2', size: 50 }, { kind: 'leaf', sessionId: 's3', size: 50 }] },
  ] }, presets: [] };
  await open(hydrateWith(asym, 3));
  expect(m!.frame()).toContain('Rows     ‹ 1 ›');
  expect(m!.frame()).toContain('Columns  ‹ 2 ›');
  expect(m!.frame()).toContain('✓ 1 large + 2 stacked');
});

test('overflow: Enter asks first, a second Enter applies, and Esc backs out to the list', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2', 's3']), 3));
  await m!.pressMany(['down', 'down', 'return']);
  expect(probe.applied.length).toBe(0);
  expect(m!.frame()).toContain('1 session will be hidden: Session s3');
  await m!.press('escape');
  await settleEscape();
  expect(probe.closed).toBe(0);
  expect(m!.frame().includes('will be hidden')).toBe(false);
  await m!.pressMany(['return', 'return']);
  expect(probe.applied.length).toBe(1);
  expect(leafCount(probe.applied[0])).toBe(2);
  expect(probe.closed).toBe(1);
});

test('type-ahead double Enter applies once', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.pressMany(['down', 'down', 'down', 'return', 'return']);
  expect(probe.applied.length).toBe(1);
  expect(probe.closed).toBe(1);
});

test('s opens the name prompt; Enter saves the trimmed name and stays open', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('s');
  expect(m!.frame()).toContain('Save current layout as');
  await m!.type(' side by side ');
  await m!.press('return');
  const msg = posts('save-preset')[0];
  expect(msg?.t === 'save-preset' && msg.name).toBe('side by side');
  expect(m!.frame().includes('Save current layout as')).toBe(false);
  expect(probe.closed).toBe(0);
});

test('a whitespace-only name posts nothing and shows an error; s and d are plain text in the prompt', async () => {
  await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('s');
  await m!.type('   ');
  await m!.press('return');
  expect(posts('save-preset').length).toBe(0);
  expect(m!.frame()).toContain('Name cannot be empty');
  await m!.type('sd');
  expect(m!.frame()).toContain('Save current layout as:    sd');
  expect(posts('delete-preset').length).toBe(0);
});

test('Esc in the name prompt cancels the prompt, not the dialog', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('s');
  await m!.press('escape');
  await settleEscape();
  expect(m!.frame().includes('Save current layout as')).toBe(false);
  expect(probe.closed).toBe(0);
});

test('saved presets are listed under their own heading, and d deletes the focused one', async () => {
  const probe = await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: [mine('p1', 'Mine')] }, 2));
  expect(m!.frame()).toContain('Saved');
  expect(m!.frame()).toContain('Mine');
  await m!.pressMany(Array.from({ length: 7 }, () => 'down'));
  await m!.press('d');
  const msg = posts('delete-preset')[0];
  expect(msg?.t === 'delete-preset' && msg.id).toBe('p1');
  expect(probe.closed).toBe(0);
});

test('d on the grid rows or a built-in row posts nothing', async () => {
  await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: [mine('p1', 'Mine')] }, 2));
  await m!.press('d');
  await m!.pressMany(['down', 'down', 'd']);
  expect(posts('delete-preset').length).toBe(0);
});

test('a preset deleted by another client under the focus ring clamps the selection instead of crashing', async () => {
  const probe = await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: [mine('p1', 'Mine')] }, 2));
  await m!.pressMany(Array.from({ length: 7 }, () => 'down'));
  await m!.fromHost({ t: 'layout-changed', layout: { root: layoutOf(['s1', 's2']).root, presets: [] } });
  await m!.press('return');
  expect(probe.applied.length).toBe(1);
  expect(m!.frame().includes('Mine')).toBe(false);
});

test('opens with no sessions at all and applies an empty shape without hiding anything', async () => {
  const probe = await open(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  expect(m!.frame()).toContain('Layout');
  await m!.pressMany(['down', 'down', 'return']);
  expect(probe.applied.length).toBe(1);
  expect(m!.frame().includes('will be hidden')).toBe(false);
});

test('Esc in the list closes without applying', async () => {
  const probe = await open(hydrateWith(layoutOf(['s1', 's2']), 2));
  await m!.press('escape');
  await settleEscape();
  expect(probe.closed).toBe(1);
  expect(probe.applied.length).toBe(0);
});

test('a long saved list is windowed and the selection stays visible', async () => {
  const many = Array.from({ length: 12 }, (_, i) => mine(`p${i}`, `Saved ${i}`));
  await open(hydrateWith({ root: layoutOf(['s1', 's2']).root, presets: many }, 2));
  await m!.pressMany(Array.from({ length: 2 + 5 + 11 }, () => 'down'));
  expect(m!.frame()).toContain('› ');
  expect(m!.frame()).toContain('Saved 11');
  expect(m!.frame().includes('2 columns')).toBe(false);
});

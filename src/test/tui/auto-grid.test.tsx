import { afterEach, expect, test } from 'bun:test';
import type { LayoutNode } from '../../client-core/layout-tree';
import { flattenLeaves, gridDims, gridLayout } from '../../client-core/layout-tree';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const SIZE = { width: 160, height: 40 };
const CUSTOM: LayoutNode = {
  kind: 'split', orientation: 'horizontal', size: 100,
  children: [
    { kind: 'leaf', sessionId: 's1', size: 50 },
    {
      kind: 'split', orientation: 'vertical', size: 50,
      children: [{ kind: 'leaf', sessionId: 's2', size: 50 }, { kind: 'leaf', sessionId: 's3', size: 50 }],
    },
  ],
};

const rows = (ids: string[]) => ids.map((id) => summary(id));
const layouts = () => m!.posted.flatMap((p) => (p.t === 'set-layout' ? [p.layout.root] : []));
const ids = (root: LayoutNode) => flattenLeaves(root).map((l) => l.sessionId).filter(Boolean);

async function boot(root: LayoutNode, shown: string[]) {
  m = await mount(<App {...props} />, SIZE);
  await m.fromHost(hydrateMsg({
    sessions: rows(shown), layout: { root, presets: [] }, snapshots: shown.map((id) => snapshot(id)),
  }));
}

test('the terminal reports its size with heights doubled for cell shape, and its smallest pane', async () => {
  await boot(CUSTOM, ['s1', 's2', 's3']);
  const sent = m!.posted.filter((p) => p.t === 'set-viewport').at(-1);
  expect(sent?.t === 'set-viewport' && sent.viewport.width).toBe(160);
  expect(sent?.t === 'set-viewport' && sent.viewport.height).toBe(80);
  expect(sent?.t === 'set-viewport' && sent.minPane.width).toBe(40);
});

test('a session the user creates into a full plain grid keeps the old placement', async () => {
  const four = ['s1', 's2', 's3', 's4'];
  await boot(gridLayout(2, 2, four).root, four);
  await m!.fromHost({ t: 'sessions-changed', sessions: rows([...four, 'new']) }, { t: 'session-snapshot', session: snapshot('new') });
  const root = layouts().at(-1) as LayoutNode;
  expect(ids(root).length).toBe(5);
  expect(gridDims(root) === undefined).toBe(true);
});

test('the host offering a rearrange shows a hint that ^W a accepts', async () => {
  await boot(CUSTOM, ['s1', 's2', 's3']);
  await m!.fromHost({ t: 'offer-rearrange' });
  expect(m!.frame()).toContain('^W a');
  await m!.press('w', { ctrl: true });
  await m!.press('a');
  const root = layouts().at(-1) as LayoutNode;
  expect(gridDims(root) !== undefined).toBe(true);
  expect(ids(root).length).toBe(3);
});

test('without an offer ^W a does nothing to the layout', async () => {
  await boot(CUSTOM, ['s1', 's2', 's3']);
  const before = layouts().length;
  await m!.press('w', { ctrl: true });
  await m!.press('a');
  expect(layouts().length).toBe(before);
});

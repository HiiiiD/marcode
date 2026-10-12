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
const lastRoot = () => {
  const last = m!.posted.filter((p) => p.t === 'set-layout').at(-1);
  if (!last || last.t !== 'set-layout') { throw new Error('no set-layout posted'); }
  return last.layout.root;
};
const ids = (root: LayoutNode) => flattenLeaves(root).map((l) => l.sessionId).filter(Boolean);

async function boot(layout: { root: LayoutNode; presets: [] }, shown: string[], autoGrid: boolean) {
  m = await mount(<App {...props} />, SIZE);
  await m.fromHost(hydrateMsg({ sessions: rows(shown), layout, snapshots: shown.map((id) => snapshot(id)), autoGrid }));
  await m.fromHost({ t: 'sessions-changed', sessions: rows([...shown, 'new']) }, { t: 'session-snapshot', session: snapshot('new') });
}

test('a full plain grid is regridded when a session arrives', async () => {
  const four = ['s1', 's2', 's3', 's4'];
  await boot({ root: gridLayout(2, 2, four).root, presets: [] }, four, true);
  expect(gridDims(lastRoot()) !== undefined).toBe(true);
  expect(ids(lastRoot()).length).toBe(5);
});

test('a full custom layout offers a rearrange that ^W a accepts', async () => {
  await boot({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], true);
  expect(gridDims(lastRoot()) === undefined).toBe(true);
  expect(m!.frame()).toContain('^W a');
  await m!.press('w', { ctrl: true });
  await m!.press('a');
  expect(gridDims(lastRoot()) !== undefined).toBe(true);
  expect(ids(lastRoot()).length).toBe(4);
});

test('with autoGrid off a custom layout offers nothing', async () => {
  await boot({ root: CUSTOM, presets: [] }, ['s1', 's2', 's3'], false);
  expect(m!.frame()).not.toContain('^W a');
});

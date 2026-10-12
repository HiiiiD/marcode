import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { gridDims, gridLayout, leafSessionIds, type LayoutNode } from '../../client-core/layout-tree';
import { focusSession } from '../../host/focus-session';
import { MessageRouter } from '../../host/message-router';
import { AttachmentStore } from '../../host/attachment-store';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';
import type { HostToWebview, SessionId } from '../../protocol/messages';

const GEOMETRY = { viewport: { width: 1800, height: 900 }, minPane: { width: 320, height: 200 } };

suite('focusSession auto-grid', () => {
  let dir: string;
  let sent: HostToWebview[];
  let manager: SessionManager;
  let ids: SessionId[];

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-focus-auto-'));
    sent = [];
    const providers = new Map<string, AgentProvider>([['fake', new FakeProvider(() => [{ kind: 'turn-end', reason: 'done' }])]]);
    manager = new SessionManager(new TranscriptStore(dir), providers, (m) => sent.push(m));
    await manager.init();
    ids = [];
    for (let i = 0; i < 5; i++) { ids.push((await manager.create('fake', '/tmp')).state.id); }
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function showFirstFour(root: LayoutNode) {
    await manager.setVisible(ids.slice(0, 4));
    manager.setLayout({ root, presets: [] });
  }
  const offers = () => sent.filter((m) => m.t === 'offer-rearrange').length;
  const customRoot = (): LayoutNode => ({
    kind: 'split', orientation: 'horizontal', size: 100,
    children: [
      { kind: 'leaf', sessionId: ids[0], size: 50 },
      {
        kind: 'split', orientation: 'vertical', size: 50,
        children: [
          { kind: 'leaf', sessionId: ids[1], size: 34 }, { kind: 'leaf', sessionId: ids[2], size: 33 },
          { kind: 'leaf', sessionId: ids[3], size: 33 },
        ],
      },
    ],
  });

  test('no geometry reported means no auto-grid options', () => {
    assert.strictEqual(manager.autoGrid(), undefined);
  });

  test('a reported geometry becomes enabled auto-grid options', () => {
    manager.setGridGeometry(GEOMETRY);
    assert.deepStrictEqual(manager.autoGrid(), { enabled: true, ...GEOMETRY });
  });

  test('a spawned session regrids a full plain grid and offers nothing', async () => {
    await showFirstFour(gridLayout(2, 2, ids.slice(0, 4)).root);
    manager.setGridGeometry(GEOMETRY);
    await focusSession(manager, ids[4], manager.autoGrid());
    const { root } = manager.layout();
    assert.deepStrictEqual(gridDims(root), { rows: 2, cols: 3 });
    assert.deepStrictEqual(leafSessionIds(root), ids);
    assert.strictEqual(offers(), 0);
  });

  test('without options a spawned session is placed the old way', async () => {
    await showFirstFour(gridLayout(2, 2, ids.slice(0, 4)).root);
    await focusSession(manager, ids[4]);
    assert.strictEqual(gridDims(manager.layout().root) === undefined, true);
    assert.strictEqual(offers(), 0);
  });

  test('a full custom layout is placed the old way and offers a rearrange once', async () => {
    await showFirstFour(customRoot());
    manager.setGridGeometry(GEOMETRY);
    await focusSession(manager, ids[4], manager.autoGrid());
    assert.strictEqual(gridDims(manager.layout().root) === undefined, true);
    assert.strictEqual(leafSessionIds(manager.layout().root).includes(ids[4]), true);
    assert.strictEqual(offers(), 1);
  });

  test('the router stores a reported viewport but a manual focus-session still places the old way', async () => {
    const router = new MessageRouter(manager, (m) => sent.push(m), '/tmp', undefined, new AttachmentStore(dir));
    await showFirstFour(gridLayout(2, 2, ids.slice(0, 4)).root);
    await router.handle({ t: 'set-viewport', ...GEOMETRY });
    assert.deepStrictEqual(manager.autoGrid(), { enabled: true, ...GEOMETRY });
    await router.handle({ t: 'focus-session', id: ids[4] });
    assert.strictEqual(gridDims(manager.layout().root) === undefined, true);
    assert.strictEqual(offers(), 0);
  });
});

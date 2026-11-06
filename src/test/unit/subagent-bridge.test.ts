import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SubagentBridge } from '../../host/subagent/subagent-bridge';
import { mirrorId } from '../../host/subagent/mirror-ids';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';

const READ: ToolCall = { kind: 'file-read', label: 'Read', path: 'a.ts' };
const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };

suite('subagent bridge', () => {
  let dir: string;
  let manager: SessionManager;
  let provider: FakeProvider;
  let scripts: Record<string, AgentEvent[]>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-bridge-'));
    scripts = {};
    provider = new FakeProvider((text) => scripts[text] ?? [{ kind: 'turn-end', reason: 'done' }]);
    manager = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {});
    await manager.init();
  });

  teardown(async () => {
    await manager.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function bridgeFor(prompt: string) {
    const parent = await manager.create('fake', dir);
    const child = await manager.createSubagent(parent.state.id, {
      providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd: dir, includeEditorContext: undefined,
    });
    const bridge = new SubagentBridge({ parent, child, cardId: 'card1', prompt });
    return { parent, child, bridge };
  }

  const cardOf = async (parent: { snapshot(): Promise<{ items: TranscriptItem[] }> }) => {
    const items = (await parent.snapshot()).items;
    return items.find((i): i is Extract<TranscriptItem, { role: 'tool' }> => i.role === 'tool' && i.toolId === 'card1')!;
  };

  test('a mirrored id is namespaced by the child', () => {
    assert.strictEqual(mirrorId('s-1', 'p:1'), 's-1:p:1');
  });

  test('a child tool nests under the card and the final text closes it', async () => {
    scripts.go = [
      { kind: 'text', delta: 'looking' },
      { kind: 'tool-start', id: 't1', tool: READ },
      { kind: 'tool-end', id: 't1', ok: true, output: { kind: 'text', text: 'x' } },
      { kind: 'text', delta: 'done!' },
      { kind: 'turn-end', reason: 'done' },
    ];
    const { parent, child, bridge } = await bridgeFor('go');
    bridge.start();
    const result = await bridge.result();
    assert.deepStrictEqual(result, { ok: true, text: 'done!', sessionId: child.state.name });
    const card = await cardOf(parent);
    assert.strictEqual(card.state, 'ok');
    assert.strictEqual(card.tool.kind, 'subagent');
    assert.deepStrictEqual((card.children ?? []).map((c) => c.role === 'tool' && c.toolId), [mirrorId(child.state.id, 't1')]);
  });

  test('a failing child settles the card as error and resolves ok:false', async () => {
    scripts.go = [{ kind: 'turn-end', reason: 'error', error: 'boom' }];
    const { parent, bridge } = await bridgeFor('go');
    bridge.start();
    const result = await bridge.result();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.text.includes('boom'), true);
    assert.strictEqual((await cardOf(parent)).state, 'error');
  });

  test('an empty reply yields an explicit placeholder', async () => {
    const { bridge } = await bridgeFor('go');
    bridge.start();
    assert.strictEqual((await bridge.result()).text, '(subagent finished with no output)');
  });

  test('a child permission surfaces on the parent and is answered through the child', async () => {
    scripts.go = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const { parent, child, bridge } = await bridgeFor('go');
    bridge.start();
    for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
    const mirrored = mirrorId(child.state.id, 'p1');
    assert.strictEqual(parent.state.status, 'awaiting-approval');
    parent.respondToPermission(mirrored, { allow: true });
    const result = await bridge.result();
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: true });
  });

  test('cancel interrupts the child, denies its pending request and settles the card', async () => {
    scripts.go = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const { parent, bridge } = await bridgeFor('go');
    bridge.start();
    for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
    bridge.cancel();
    const result = await bridge.result();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.text, 'Subagent cancelled');
    assert.strictEqual((await cardOf(parent)).state, 'error');
    assert.notStrictEqual(parent.state.status, 'awaiting-approval');
  });
});

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import type { ToolCall, TranscriptItem } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent, AgentProvider } from '../../providers/types';

const BASH: ToolCall = { kind: 'command', label: 'Bash', command: 'ls' };
const spec = (cwd: string) => ({
  providerId: 'fake', model: undefined, effort: undefined, mode: undefined, cwd, includeEditorContext: undefined,
});
const tick = async (n = 10) => { for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 5)); } };

suite('subagent reload', () => {
  let dir: string;
  let managers: SessionManager[];
  let scripts: Record<string, AgentEvent[]>;

  const open = async (): Promise<SessionManager> => {
    const provider = new FakeProvider((text) => {
      const key = Object.keys(scripts).find((k) => text.endsWith(k));
      return key ? scripts[key] : [{ kind: 'turn-end', reason: 'done' }];
    });
    const m = new SessionManager(new TranscriptStore(dir), new Map<string, AgentProvider>([['fake', provider]]), () => {});
    await m.init();
    managers.push(m);
    return m;
  };

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-subreload-'));
    managers = [];
    scripts = {};
  });

  teardown(async () => {
    for (const m of managers) { await m.dispose().catch(() => undefined); }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test('a card left running across a reload comes back settled, not running', async () => {
    scripts.job = [{ kind: 'permission', id: 'p1', tool: BASH }];
    const first = await open();
    const parent = await first.create('fake', dir);
    await first.subagents.runBackground(parent.state.id, spec(dir), 'job');
    await tick();
    await first.persistNow();
    await first.dispose();

    const second = await open();
    const session = await second.open(parent.state.id);
    const cards = (await session.snapshot()).items.filter(
      (i): i is Extract<TranscriptItem, { role: 'tool' }> => i.role === 'tool' && i.tool.kind === 'subagent',
    );
    assert.strictEqual(cards.length, 1);
    assert.notStrictEqual(cards[0].state, 'running');
  });

  test('a restored subagent row stays out of the roster and is idle', async () => {
    const first = await open();
    const parent = await first.create('fake', dir);
    await first.subagents.run(parent.state.id, spec(dir), 'job');
    await first.persistNow();
    await first.dispose();

    const second = await open();
    const child = second.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    assert.strictEqual(child.status, 'idle');
    assert.strictEqual(child.parentId, parent.state.id);
    assert.strictEqual(second.summaries().some((s) => s.id === child.id), false);
  });

  test('a subagent whose parent is gone is removed at startup', async () => {
    const first = await open();
    const orphan = await first.create('fake', dir, undefined, undefined, undefined, undefined, true, 's-gone', 'subagent');
    await first.persistNow();
    await first.dispose();

    const second = await open();
    assert.strictEqual(second.lookup(orphan.state.id), undefined);
  });

  test('removing a parent removes its subagents too', async () => {
    const first = await open();
    const parent = await first.create('fake', dir);
    await first.subagents.run(parent.state.id, spec(dir), 'job');
    const child = first.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    await first.remove(parent.state.id);
    assert.strictEqual(first.lookup(child.id), undefined);
    assert.strictEqual(first.lookup(parent.state.id), undefined);
  });

  test('hiding a parent keeps its subagents', async () => {
    const first = await open();
    const parent = await first.create('fake', dir);
    await first.subagents.run(parent.state.id, spec(dir), 'job');
    const child = first.summaries({ includeSubagents: true }).find((s) => s.kind === 'subagent')!;
    await first.close(parent.state.id);
    assert.strictEqual(first.lookup(child.id) !== undefined, true);
  });
});

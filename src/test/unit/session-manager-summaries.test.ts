import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { SessionManager } from '../../host/session-manager';
import { FtsMemoryStore } from '../../memory/fts-memory-store';
import { TranscriptStore } from '../../host/transcript-store';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { HostToWebview } from '../../protocol/messages';
import type { AgentProvider } from '../../providers/types';

async function rig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-summaries-'));
  const store = new TranscriptStore(dir);
  const sent: HostToWebview[] = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
  const manager = new SessionManager(store, providers, (m) => sent.push(m));
  await manager.init();
  return { sent, manager };
}

suite('SessionManager summaries', () => {
  test('fills a stale summary from the transcript and keys it to updatedAt', async () => {
    const { manager } = await rig();
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    const s = manager.summaries().find((x) => x.id === session.state.id)!;
    assert.strictEqual(s.summary?.text.startsWith('Investigate the flaky login test'), true);
    assert.strictEqual(s.summary?.forUpdatedAt, s.updatedAt);
    await manager.dispose();
  });

  test('a fresh summary is not recomputed and emits nothing', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello there');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    sent.length = 0;
    await manager.ensureSummaries();
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });

  test('untitled sessions are skipped', async () => {
    const { manager } = await rig();
    const session = await manager.create('fake', '/repo');
    await manager.ensureSummaries();
    assert.strictEqual(manager.summaries().find((x) => x.id === session.state.id)!.summary, undefined);
    await manager.dispose();
  });

  test('concurrent calls share one run', async () => {
    const { manager, sent } = await rig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello');
    await manager.close(session.state.id);
    sent.length = 0;
    await Promise.all([manager.ensureSummaries(), manager.ensureSummaries()]);
    assert.strictEqual(sent.filter((m) => m.t === 'sessions-changed').length, 1);
    await manager.dispose();
  });
});

async function memoryRig() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-summaries-mem-'));
  const store = new TranscriptStore(dir);
  const memory = new FtsMemoryStore(path.join(dir, 'memory.sqlite'), { tail: (id, n) => store.tail(id, n) });
  const sent: HostToWebview[] = [];
  const providers = new Map<string, AgentProvider>([['fake', new FakeProvider()]]);
  const manager = new SessionManager(
    store, providers, (m) => sent.push(m), undefined, undefined, undefined, undefined, undefined, memory,
  );
  await manager.init();
  return { sent, manager, memory };
}

suite('SessionManager summaries with memory enabled', () => {
  test('the history summary is a projection of the stored digest', async () => {
    const { manager, memory } = await memoryRig();
    const session = await manager.create('fake', '/repo');
    session.send('Investigate the flaky login test');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    const s = manager.summaries().find((x) => x.id === session.state.id)!;
    const digest = await memory.getDigest(session.state.id);
    assert.strictEqual(s.summary?.text.startsWith('Investigate the flaky login test'), true);
    assert.strictEqual(s.summary?.forUpdatedAt, digest?.forUpdatedAt);
    await manager.dispose();
  });

  test('a current digest is not rewritten and ensureSummaries emits nothing', async () => {
    const { manager, sent } = await memoryRig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello there');
    await manager.close(session.state.id);
    await manager.ensureSummaries();
    sent.length = 0;
    await manager.ensureSummaries();
    assert.strictEqual(sent.length, 0);
    await manager.dispose();
  });

  test('memoryStatus reports enabled with no llm by default', async () => {
    const { manager } = await memoryRig();
    assert.deepStrictEqual(manager.memoryStatus(), { enabled: true, llm: false });
    await manager.dispose();
  });

  test('memoryStatus reports disabled with no store', async () => {
    const { manager } = await rig();
    assert.deepStrictEqual(manager.memoryStatus(), { enabled: false, llm: false });
    await manager.dispose();
  });

  test('memoryReindex emits progress and a final done', async () => {
    const { manager, sent } = await memoryRig();
    const session = await manager.create('fake', '/repo');
    session.send('Hello there');
    await manager.close(session.state.id);
    sent.length = 0;
    await manager.memoryReindex('all');
    const phases = sent.filter((m) => m.t === 'memory-progress').map((m) => (m as { phase: string }).phase);
    assert.strictEqual(phases[phases.length - 1], 'done');
    await manager.dispose();
  });

  test('memory methods are safe no-ops with memory disabled', async () => {
    const { manager } = await rig();
    await assert.doesNotReject(manager.memoryReindex('all'));
    assert.deepStrictEqual(await manager.memoryEstimate('all'), { sessions: 0, approxInputTokens: 0 });
    await manager.dispose();
  });
});

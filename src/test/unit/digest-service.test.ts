import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { DigestService, type DigestProgress, type DigestSession, type DigestSource } from '../../host/digest/digest-service';
import { SUMMARIZER_VERSION, type SessionDigest } from '../../memory/digest';
import type { DigestMeta, MemoryStore, SessionRecord } from '../../memory/types';
import type { TranscriptItem } from '../../protocol/messages';

const transcript = (text: string): TranscriptItem[] => [
  { id: 'u', ts: 0, role: 'user', text }, { id: 'a', ts: 0, role: 'assistant', text: 'ok' },
];

class FakeStore implements MemoryStore {
  digests = new Map<string, SessionDigest>();
  indexed: string[] = [];
  async index(r: SessionRecord) {
    this.digests.set(r.sessionId, r.digest!);
    this.indexed.push(r.sessionId);
  }
  async search() { return []; }
  async fetch() { return { sessionId: '', items: [] }; }
  async forget(id: string) { this.digests.delete(id); }
  async getDigest(id: string) { return this.digests.get(id); }
  async digestMeta() {
    return new Map<string, DigestMeta>([...this.digests].map(([id, d]) => [id, {
      source: d.source, summarizerVersion: d.summarizerVersion, forUpdatedAt: d.forUpdatedAt,
    }]));
  }
}

function rig(sessions: DigestSession[], opts: {
  summarize?: (items: TranscriptItem[], base: SessionDigest) => Promise<SessionDigest>;
} = {}) {
  const store = new FakeStore();
  const projected = new Map<string, number>();
  const progress: DigestProgress[] = [];
  let settled = 0;
  const source: DigestSource = {
    sessions: () => sessions,
    transcript: async (id) => transcript(`task ${id}`),
    projected: (id) => projected.get(id),
  };
  const service = new DigestService({
    store, source,
    summarizer: opts.summarize ? { summarize: opts.summarize } : undefined,
    onDigest: (id, d) => { projected.set(id, d.forUpdatedAt); },
    onSettled: () => { settled++; },
    onProgress: (p) => progress.push(p),
  });
  return { store, service, progress, settled: () => settled, projected };
}

const session = (id: string, over: Partial<DigestSession> = {}): DigestSession => ({
  id, providerId: 'claude', cwd: '/r', title: `t-${id}`, hidden: true, updatedAt: 10, ...over,
});

const llmDigest = (base: SessionDigest): SessionDigest => ({ ...base, source: 'llm', title: 'LLM title' });

suite('DigestService', () => {
  test('refresh writes an extractive digest and projects it', async () => {
    const { store, service, projected } = rig([session('a')]);
    await service.refresh('a');
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
    assert.strictEqual(projected.get('a'), 10);
  });

  test('untitled sessions are skipped', async () => {
    const { store, service } = rig([session('a', { title: 'Untitled' })]);
    await service.refresh('a');
    assert.strictEqual(store.digests.size, 0);
  });

  test('a failing store write is logged and does not reject', async () => {
    const { store, service } = rig([session('a')]);
    store.index = async () => { throw new Error('disk full'); };
    await assert.doesNotReject(service.refresh('a'));
  });

  test('upgrade replaces the extractive digest with the llm one for a closed session', async () => {
    const { store, service } = rig([session('a')], { summarize: async (_i, base) => llmDigest(base) });
    await service.refresh('a');
    await service.upgrade('a');
    assert.strictEqual(store.digests.get('a')?.source, 'llm');
  });

  test('upgrade skips a live session', async () => {
    const { store, service } = rig([session('a', { hidden: false })], { summarize: async (_i, b) => llmDigest(b) });
    await service.refresh('a');
    await service.upgrade('a');
    assert.strictEqual(store.digests.has('a'), false);
  });

  test('a live session gets a history projection but is never written to the store', async () => {
    const { store, service, projected } = rig([session('a', { hidden: false })]);
    await service.refresh('a');
    assert.strictEqual(projected.get('a'), 10);
    assert.strictEqual(store.digests.size, 0);
  });

  test('ensureCurrent projects a live session once and then leaves it alone', async () => {
    const { store, service, settled } = rig([session('a', { hidden: false })]);
    await service.ensureCurrent();
    const after = settled();
    await service.ensureCurrent();
    assert.strictEqual(store.digests.size, 0);
    assert.strictEqual(settled(), after);
  });

  test('forget removes a stored digest', async () => {
    const { store, service } = rig([session('a')]);
    await service.refresh('a');
    await service.forget('a');
    assert.strictEqual(store.digests.has('a'), false);
  });

  test('an llm digest is not written if the session was reopened while the model was working', async () => {
    const sessions = [session('a')];
    const gate: { release?: () => void } = {};
    const { store, service } = rig(sessions, {
      summarize: (_i, base) => new Promise((resolve) => { gate.release = () => resolve(llmDigest(base)); }),
    });
    await service.refresh('a');
    const upgrading = service.upgrade('a');
    await new Promise((r) => setTimeout(r, 20));
    sessions[0] = session('a', { hidden: false });
    gate.release?.();
    await upgrading;
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('a failing summarizer keeps the extractive digest and does not reject', async () => {
    const { store, service } = rig([session('a')], { summarize: async () => { throw new Error('timeout'); } });
    await service.refresh('a');
    await assert.doesNotReject(service.upgrade('a'));
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('ensureCurrent fills missing digests, leaves current ones alone, and settles once', async () => {
    const { store, service, settled } = rig([session('a'), session('b')]);
    await service.refresh('a');
    store.indexed.length = 0;
    const before = settled();
    await service.ensureCurrent();
    assert.deepStrictEqual(store.indexed, ['b']);
    assert.strictEqual(settled() - before, 1);
  });

  test('ensureCurrent projects a current stored digest that the session has not been given yet', async () => {
    const { store, service, projected } = rig([session('a')]);
    await service.refresh('a');
    projected.clear();
    store.indexed.length = 0;
    await service.ensureCurrent();
    assert.strictEqual(projected.get('a'), 10);
    assert.deepStrictEqual(store.indexed, []);
  });

  test('a stale digest (older updatedAt) is rebuilt', async () => {
    const sessions = [session('a')];
    const { store, service } = rig(sessions);
    await service.refresh('a');
    sessions[0] = session('a', { updatedAt: 20 });
    await service.ensureCurrent();
    assert.strictEqual(store.digests.get('a')?.forUpdatedAt, 20);
  });

  test('reindex missing-llm builds extractive first, then upgrades closed sessions, newest first', async () => {
    const order: string[] = [];
    const { store, service, progress } = rig(
      [session('old', { updatedAt: 1 }), session('new', { updatedAt: 5 }), session('live', { hidden: false, updatedAt: 9 })],
      { summarize: async (_i, base) => { order.push(base.title); return llmDigest(base); } },
    );
    await service.reindex('missing-llm');
    assert.strictEqual(store.digests.get('new')?.source, 'llm');
    assert.strictEqual(store.digests.get('old')?.source, 'llm');
    assert.strictEqual(store.digests.has('live'), false);
    assert.deepStrictEqual(order, ['task new', 'task old']);
    assert.strictEqual(progress[progress.length - 1].phase, 'done');
  });

  test('re-running skips sessions whose llm digest is already current', async () => {
    let calls = 0;
    const { service } = rig([session('a')], { summarize: async (_i, b) => { calls++; return llmDigest(b); } });
    await service.reindex('missing-llm');
    await service.reindex('missing-llm');
    assert.strictEqual(calls, 1);
  });

  test('scope all rebuilds even current llm digests', async () => {
    let calls = 0;
    const { service } = rig([session('a')], { summarize: async (_i, b) => { calls++; return llmDigest(b); } });
    await service.reindex('missing-llm');
    await service.reindex('all');
    assert.strictEqual(calls, 2);
  });

  test('without a summarizer reindex only does the extractive pass', async () => {
    const { store, service } = rig([session('a')]);
    await service.reindex('all');
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('estimate counts closed sessions that still need an llm digest', async () => {
    const { service } = rig(
      [session('a'), session('b'), session('live', { hidden: false })],
      { summarize: async (_i, b) => llmDigest(b) },
    );
    assert.deepStrictEqual(await service.estimate('missing-llm'), { sessions: 2, approxInputTokens: 6000 });
  });

  test('estimate is zero with no summarizer configured', async () => {
    const { service } = rig([session('a')]);
    assert.deepStrictEqual(await service.estimate('all'), { sessions: 0, approxInputTokens: 0 });
  });

  test('cancel stops a running reindex and reports cancelled', async () => {
    const gate: { release?: () => void } = {};
    const { service, progress } = rig(
      [session('a'), session('b'), session('c')],
      {
        summarize: (_i, base) => new Promise((resolve) => {
          gate.release = () => resolve(llmDigest(base));
        }),
      },
    );
    const run = service.reindex('all');
    await new Promise((r) => setTimeout(r, 20));
    service.cancel();
    gate.release?.();
    await run;
    assert.strictEqual(progress[progress.length - 1].phase, 'cancelled');
  });

  test('a close-time refresh is not starved behind a long reindex', async () => {
    const many = Array.from({ length: 50 }, (_, i) => session(`s${i}`));
    const { store, service } = rig(many);
    const run = service.reindex('all');
    await service.refresh('s49');
    const at = store.indexed.indexOf('s49');
    assert.strictEqual(at >= 0 && at < 49, true);
    await run;
  });

  test('a session removed while the model is summarizing is not indexed', async () => {
    const sessions = [session('a')];
    const gate: { release?: () => void } = {};
    const { store, service } = rig(sessions, {
      summarize: (_i, base) => new Promise((resolve) => { gate.release = () => resolve(llmDigest(base)); }),
    });
    await service.refresh('a');
    const upgrading = service.upgrade('a');
    await new Promise((r) => setTimeout(r, 20));
    sessions.length = 0;
    gate.release?.();
    await upgrading;
    assert.strictEqual(store.digests.get('a')?.source, 'extractive');
  });

  test('a failing digestMeta is logged and does not reject ensureCurrent', async () => {
    const { store, service } = rig([session('a')]);
    store.digestMeta = async () => { throw new Error('locked'); };
    await assert.doesNotReject(service.ensureCurrent());
  });

  test('a close-time refresh does not wait behind a running llm job', async () => {
    const gate: { release?: () => void } = {};
    const { store, service } = rig([session('a'), session('b')], {
      summarize: (_i, base) => new Promise((resolve) => { gate.release = () => resolve(llmDigest(base)); }),
    });
    await service.refresh('a');
    const upgrading = service.upgrade('a');
    await new Promise((r) => setTimeout(r, 20));
    await service.refresh('b');
    assert.strictEqual(store.digests.has('b'), true);
    gate.release?.();
    await upgrading;
  });

  test('ensureCurrent works one session at a time so a close-time refresh slips in', async () => {
    const many = Array.from({ length: 50 }, (_, i) => session(`s${i}`));
    const { store, service } = rig(many);
    const sweep = service.ensureCurrent();
    await service.refresh('s49');
    assert.strictEqual(store.indexed.indexOf('s49') < 49, true);
    await sweep;
  });

  test('refresh never downgrades a current llm digest', async () => {
    const { store, service } = rig([session('a')], { summarize: async (_i, b) => llmDigest(b) });
    await service.refresh('a');
    await service.upgrade('a');
    await service.refresh('a');
    assert.strictEqual(store.digests.get('a')?.source, 'llm');
  });

  test('resummarize keeps the previous llm digest when the model fails', async () => {
    let fail = false;
    const { store, service } = rig([session('a')], {
      summarize: async (_i, b) => { if (fail) { throw new Error('boom'); } return llmDigest(b); },
    });
    await service.resummarize('a');
    assert.strictEqual(store.digests.get('a')?.source, 'llm');
    fail = true;
    await service.resummarize('a');
    assert.strictEqual(store.digests.get('a')?.source, 'llm');
  });

  test('stop makes queued work a no-op', async () => {
    const { store, service } = rig([session('a')]);
    service.stop();
    await service.refresh('a');
    assert.strictEqual(store.digests.size, 0);
  });

  test('the current summarizer version constant is stamped on digests', async () => {
    const { store, service } = rig([session('a')]);
    await service.refresh('a');
    assert.strictEqual(store.digests.get('a')?.summarizerVersion, SUMMARIZER_VERSION);
  });
});

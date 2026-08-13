import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TranscriptStore } from '../../host/transcript-store';
import type { TranscriptItem } from '../../protocol/messages';

function item(id: string, text: string): TranscriptItem {
  return { id, ts: 1, role: 'user', text };
}

suite('TranscriptStore', () => {
  let dir: string;
  let store: TranscriptStore;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiiiid-store-'));
    store = new TranscriptStore(dir);
  });

  teardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('round-trips appended items through disk', async () => {
    store.append('s1', item('a', 'one'));
    store.append('s1', item('b', 'two'));
    await store.flush();

    const fresh = new TranscriptStore(dir);
    const { items, hasMore } = await fresh.tail('s1');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, 'a');
    assert.strictEqual(items[1].id, 'b');
    assert.strictEqual(hasMore, false);
  });

  test('tail returns the last N items and reports more history', async () => {
    for (let i = 0; i < 10; i++) { store.append('s1', item(`i${i}`, `t${i}`)); }
    await store.flush();

    const { items, hasMore } = await store.tail('s1', 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['i7', 'i8', 'i9']);
    assert.strictEqual(hasMore, true);
  });

  test('before pages backward from an item id', async () => {
    for (let i = 0; i < 10; i++) { store.append('s1', item(`i${i}`, `t${i}`)); }
    await store.flush();

    const { items, hasMore } = await store.before('s1', 'i7', 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['i4', 'i5', 'i6']);
    assert.strictEqual(hasMore, true);

    const rest = await store.before('s1', 'i4', 10);
    assert.deepStrictEqual(rest.items.map((i) => i.id), ['i0', 'i1', 'i2', 'i3']);
    assert.strictEqual(rest.hasMore, false);
  });

  test('replace updates an item in place and survives reload', async () => {
    store.append('s1', {
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state: 'pending',
    });
    await store.flush();

    store.replace('s1', {
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state: 'allowed',
    });
    await store.flush();

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.strictEqual(items.length, 1);
    assert.strictEqual((items[0] as { state: string }).state, 'allowed');
  });

  test('tail on an unknown session returns empty rather than throwing', async () => {
    const { items, hasMore } = await store.tail('missing');
    assert.deepStrictEqual(items, []);
    assert.strictEqual(hasMore, false);
  });

  test('index round-trips', async () => {
    await store.writeIndex({
      sessions: [{
        id: 's1', providerId: 'fake', model: 'fake-large', title: 'T', cwd: '/tmp',
        status: 'idle', permissionMode: 'default',
        usage: { inputTokens: 0, outputTokens: 0 },
        archived: false, createdAt: 1, updatedAt: 1,
      }],
      layout: { orientation: 'vertical', panes: [{ sessionId: 's1', size: 100 }] },
    });

    const fresh = new TranscriptStore(dir);
    const index = await fresh.readIndex();
    assert.strictEqual(index.sessions.length, 1);
    assert.strictEqual(index.sessions[0].id, 's1');
    assert.strictEqual(index.layout.panes[0].sessionId, 's1');
  });

  test('readIndex on a fresh directory returns an empty index', async () => {
    const index = await store.readIndex();
    assert.deepStrictEqual(index.sessions, []);
    assert.deepStrictEqual(index.layout, { orientation: 'vertical', panes: [] });
  });

  test('remove deletes the file, clears the cache, and stays gone after a later flush', async () => {
    store.append('s1', item('a', 'one'));
    store.append('s1', item('b', 'two'));
    await store.flush();
    await store.tail('s1');

    const sessionFile = path.join(dir, 'sessions', 's1.jsonl');
    await fs.access(sessionFile);

    await store.remove('s1');

    await assert.rejects(fs.access(sessionFile), /ENOENT/);

    const { items, hasMore } = await store.tail('s1');
    assert.deepStrictEqual(items, []);
    assert.strictEqual(hasMore, false);

    await store.flush();
    await assert.rejects(fs.access(sessionFile), /ENOENT/);
  });

  test('overlapping flush() calls for the same id do not duplicate items', async () => {
    store.append('s1', item('a', 'one'));
    store.append('s1', item('b', 'two'));

    // Two calls racing for the same session id — one naming the id
    // explicitly (as AgentSession does), one flushing "everything pending"
    // (as SessionManager's periodic persist does) — must serialize rather
    // than both observing the same pending queue and each writing it.
    await Promise.all([store.flush('s1'), store.flush()]);

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(items.map((i) => i.id), ['a', 'b']);
  });

  test('a concurrent flush() cannot let its write land after remove() has deleted the file', async () => {
    // Deterministically reproduces the exact interleave from the finding —
    // flush()'s underlying fs.appendFile is genuinely in flight (not just
    // "about to be called") when remove() runs for the same id — without
    // depending on real disk-I/O timing. We patch fs.appendFile (the shared
    // 'fs/promises' module instance also used inside transcript-store.ts)
    // to pause right after flush() has read the pending queue and issued
    // the write, let remove() run, then release the write and confirm it
    // cannot resurrect the file remove() just deleted.
    const id = 's1';
    store.append(id, item('a', 'one'));

    // `import * as fs` gives us a read-only forwarding view (TS namespace
    // import semantics), so patch the live 'fs/promises' module object
    // directly via require — the same singleton module instance
    // transcript-store.ts reads from at call time.
    const fsPromisesModule = require('fs/promises') as typeof fs;
    const realAppendFile = fsPromisesModule.appendFile;
    let releaseWrite: (() => void) | undefined;
    let writeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    fsPromisesModule.appendFile = async (...args: Parameters<typeof fs.appendFile>) => {
      writeStarted?.();
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
      return realAppendFile(...args);
    };

    try {
      const flushPromise = store.flush(id);
      await started; // flush() has read the pending queue and is mid-write.
      const removePromise = store.remove(id);
      // Give remove() a chance to run everything it can before the write
      // it's racing against is allowed to land.
      for (let i = 0; i < 5; i++) { await new Promise((r) => setImmediate(r)); }
      releaseWrite?.();
      await Promise.all([flushPromise, removePromise]);
    } finally {
      fsPromisesModule.appendFile = realAppendFile;
    }

    const sessionFile = path.join(dir, 'sessions', `${id}.jsonl`);
    await assert.rejects(
      fs.access(sessionFile),
      /ENOENT/,
      'remove() must win — the file must not exist after both settle',
    );
  });

  test('an append() landing during flush()\'s write is not discarded', async () => {
    // The event pump calls append() synchronously; SessionManager's periodic
    // persist timer can have a flush() write in flight at that exact moment.
    // flushOne() must have taken the queue *before* its first await, so the
    // late append lands in a fresh queue instead of being cleared unwritten.
    store.append('s1', item('i1', 'one'));

    const fsPromisesModule = require('fs/promises') as typeof fs;
    const realAppendFile = fsPromisesModule.appendFile;
    let fired = false;
    fsPromisesModule.appendFile = async (...args: Parameters<typeof fs.appendFile>) => {
      const result = await realAppendFile(...args);
      if (!fired) {
        fired = true;
        // A tool-start/permission event arriving mid-write.
        store.append('s1', item('i2', 'two'));
      }
      return result;
    };

    try {
      await store.flush();
      await store.flush();
    } finally {
      fsPromisesModule.appendFile = realAppendFile;
    }

    assert.strictEqual(fired, true, 'the mid-write append must actually have fired');

    const live = await store.tail('s1');
    assert.deepStrictEqual(live.items.map((i) => i.id), ['i1', 'i2'],
      'the in-memory cache must still hold the mid-write append');

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.deepStrictEqual(items.map((i) => i.id), ['i1', 'i2'],
      'the mid-write append must reach disk on the next flush');
  });

  test('a replace() landing during flush()\'s rewrite is not discarded', async () => {
    const perm = (state: 'pending' | 'allowed' | 'denied'): TranscriptItem => ({
      id: 'p1', ts: 1, role: 'permission', requestId: 'r1',
      name: 'Bash', input: {}, state,
    });

    store.append('s1', perm('pending'));
    await store.flush();
    store.replace('s1', perm('allowed')); // marks the session dirty (rewrite path)

    const fsPromisesModule = require('fs/promises') as typeof fs;
    const realWriteFile = fsPromisesModule.writeFile;
    let fired = false;
    fsPromisesModule.writeFile = async (...args: Parameters<typeof fs.writeFile>) => {
      const result = await realWriteFile(...args);
      if (!fired) {
        fired = true;
        // The user answers the permission card while the rewrite is in flight.
        store.replace('s1', perm('denied'));
      }
      return result;
    };

    try {
      await store.flush();
      await store.flush();
    } finally {
      fsPromisesModule.writeFile = realWriteFile;
    }

    assert.strictEqual(fired, true, 'the mid-write replace must actually have fired');

    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.strictEqual(items.length, 1);
    assert.strictEqual((items[0] as { state: string }).state, 'denied',
      'the mid-rewrite replacement must survive to disk');
  });

  test('a corrupt JSONL line is skipped rather than throwing out of a read path', async () => {
    // Exactly what a kill during a non-atomic write leaves behind: a
    // truncated final line. tail() must never throw — the pane would render
    // permanently blank with no error state.
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'sessions', 's1.jsonl'),
      '{"id":"i1","ts":1,"role":"user","text":"one"}\n{"id":"i2","ts":2,"ro',
      'utf8',
    );

    const { items } = await store.tail('s1');
    assert.ok(items.some((i) => i.id === 'i1'), 'the parseable history must survive');
    assert.ok(items.some((i) => i.role === 'error'),
      'the skipped line must surface as an error transcript item, not silence');
  });

  test('a torn rewrite leaves the previous transcript intact and re-queues the write', async () => {
    store.append('s1', item('a', 'one'));
    await store.flush();
    const sessionFile = path.join(dir, 'sessions', 's1.jsonl');
    const before = await fs.readFile(sessionFile, 'utf8');

    store.replace('s1', item('a', 'changed')); // dirty -> rewrite path

    const fsPromisesModule = require('fs/promises') as typeof fs;
    const realWriteFile = fsPromisesModule.writeFile;
    let torn = false;
    fsPromisesModule.writeFile = async (
      file: Parameters<typeof fs.writeFile>[0],
      data: Parameters<typeof fs.writeFile>[1],
      options?: Parameters<typeof fs.writeFile>[2],
    ) => {
      torn = true;
      // Simulate the process dying part-way through the write.
      await realWriteFile(file, String(data).slice(0, 12), options);
      throw new Error('simulated torn write');
    };

    try {
      await assert.rejects(store.flush('s1'), /simulated torn write/);
    } finally {
      fsPromisesModule.writeFile = realWriteFile;
    }
    assert.strictEqual(torn, true);

    assert.strictEqual(await fs.readFile(sessionFile, 'utf8'), before,
      'a failed rewrite must not corrupt the file it was replacing');

    // Nothing was dropped: retrying the flush still lands the replacement.
    await store.flush('s1');
    const fresh = new TranscriptStore(dir);
    const { items } = await fresh.tail('s1');
    assert.strictEqual(items.length, 1);
    assert.strictEqual((items[0] as { text: string }).text, 'changed');
  });

  test('remove on a session with unflushed pending appends is not resurrected by a later flush', async () => {
    store.append('s1', item('a', 'one'));

    await store.remove('s1');
    await store.flush();

    const sessionFile = path.join(dir, 'sessions', 's1.jsonl');
    await assert.rejects(fs.access(sessionFile), /ENOENT/);

    const { items, hasMore } = await store.tail('s1');
    assert.deepStrictEqual(items, []);
    assert.strictEqual(hasMore, false);
  });
});

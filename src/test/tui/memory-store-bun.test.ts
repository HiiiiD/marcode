import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FtsMemoryStore } from '../../memory/fts-memory-store';
import type { TranscriptItem } from '../../protocol/messages';

const reader = { tail: async () => ({ items: [] as TranscriptItem[], hasMore: false }) };
const item = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });

async function dbPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marcode-bun-memory-'));
  return path.join(dir, 'memory.sqlite');
}

function runNode(...args: string[]): string {
  const res = spawnSync('node', ['--require', 'tsx/cjs', 'src/test/tui/node-memory-cli.ts', ...args], {
    encoding: 'utf8', cwd: process.cwd(),
  });
  if (res.status !== 0) { throw new Error(`node helper failed: ${res.stderr}`); }
  return res.stdout.trim().split('\n').pop() ?? '';
}

test('this suite runs under Bun', () => {
  expect(Boolean(process.versions.bun)).toBe(true);
});

test('index then search by keyword, and an unknown session has no digest', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'Investigate the flaky login test')] });
  const hits = await store.search('flaky login');
  expect(hits.map((h) => h.sessionId)).toEqual(['s1']);
  expect(hits[0].itemId).toBe('u1');
  expect(await store.getDigest('nope')).toBeUndefined();
  expect((await store.getDigest('s1'))?.title === undefined).toBe(false);
  store.close();
});

test('search keeps only sessions inside the folder', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 'in', providerId: 'claude', cwd: path.join(os.tmpdir(), 'ws', 'a'), closedAt: 1, items: [item('u1', 'giraffe rollout')] });
  await store.index({ sessionId: 'out', providerId: 'claude', cwd: path.join(os.tmpdir(), 'elsewhere'), closedAt: 2, items: [item('u2', 'giraffe rollout')] });
  const hits = await store.search('giraffe', { cwdWithin: path.join(os.tmpdir(), 'ws') });
  expect(hits.map((h) => h.sessionId)).toEqual(['in']);
  store.close();
});

test('punctuation-only and empty queries return no hits instead of an FTS5 error', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'anything')] });
  expect(await store.search('?? : /')).toEqual([]);
  expect(await store.search('')).toEqual([]);
  store.close();
});

test('forget removes the row and the digest', async () => {
  const store = new FtsMemoryStore(await dbPath(), reader);
  await store.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'giraffe')] });
  await store.forget('s1');
  expect(await store.search('giraffe')).toEqual([]);
  expect(await store.getDigest('s1')).toBeUndefined();
  store.close();
});

test('a database with a stale schema version is rebuilt, not failed', async () => {
  const file = await dbPath();
  const old = new FtsMemoryStore(file, reader, 1);
  await old.index({ sessionId: 's1', providerId: 'claude', cwd: '/repo', closedAt: 1, items: [item('u1', 'giraffe')] });
  old.close();
  const fresh = new FtsMemoryStore(file, reader);
  expect(await fresh.search('giraffe')).toEqual([]);
  await fresh.index({ sessionId: 's2', providerId: 'claude', cwd: '/repo', closedAt: 2, items: [item('u2', 'giraffe')] });
  expect((await fresh.search('giraffe')).map((h) => h.sessionId)).toEqual(['s2']);
  fresh.close();
});

test('a Node process and a Bun process on one file each find the other\'s session', async () => {
  const file = await dbPath();
  const store = new FtsMemoryStore(file, reader);
  runNode('write', file);
  expect((await store.search('zebra')).map((h) => h.sessionId)).toEqual(['from-node']);
  await store.index({ sessionId: 'from-bun', providerId: 'claude', cwd: '/repo', closedAt: 2, items: [item('b1', 'giraffe rollout notes')] });
  store.close();
  expect(JSON.parse(runNode('search', file, 'giraffe'))).toEqual(['from-bun']);
});

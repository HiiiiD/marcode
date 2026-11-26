import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { codeGroups, countdown, hostOf, lastSeen, middleTruncate } from '../../client-core/sync/sync-format';
import { initialState, reduce } from '../../webview/reducer';
import type { SyncPanel } from '../../protocol/messages';
import { layoutOf } from '../fixtures/protocol';

const NOW = 1_000_000_000;
const hydrate = (syncStatus?: 'ok' | 'offline') => ({
  t: 'hydrate' as const, sessions: [], layout: layoutOf([]), snapshots: [], catalog: [], unavailable: [], usage: {},
  ...(syncStatus ? { syncStatus } : {}),
});

suite('sync formatting', () => {
  test('hostOf keeps only the host', () => {
    assert.strictEqual(hostOf('https://sync.example.com/marcode'), 'sync.example.com');
    assert.strictEqual(hostOf('http://127.0.0.1:8787'), '127.0.0.1:8787');
    assert.strictEqual(hostOf('not a url'), 'not a url');
  });

  test('lastSeen at its boundaries', () => {
    assert.strictEqual(lastSeen(NOW - 59_000, NOW), 'just now');
    assert.strictEqual(lastSeen(NOW - 5 * 60_000, NOW), '5 min ago');
    assert.strictEqual(lastSeen(NOW - 3 * 3_600_000, NOW), '3 h ago');
    assert.strictEqual(lastSeen(NOW - 48 * 3_600_000, NOW), '2 days ago');
  });

  test('countdown counts minutes and seconds, empty once expired', () => {
    assert.strictEqual(countdown(NOW + (14 * 60 + 32) * 1000, NOW), '14:32');
    assert.strictEqual(countdown(NOW + 5_000, NOW), '0:05');
    assert.strictEqual(countdown(NOW, NOW), '');
    assert.strictEqual(countdown(NOW - 1, NOW), '');
  });

  test('middleTruncate keeps both ends', () => {
    assert.strictEqual(middleTruncate('short', 10), 'short');
    const cut = middleTruncate('github.com/some-organisation/marcode', 20);
    assert.strictEqual(cut.length, 20);
    assert.strictEqual(cut.startsWith('github.com'), true);
    assert.strictEqual(cut.endsWith('marcode'), true);
    assert.strictEqual(cut.includes('…'), true);
  });

  test('codeGroups splits on hyphens', () => {
    assert.deepStrictEqual(codeGroups('MRC-ABCDEF-GHIJKL-MN'), ['MRC', 'ABCDEF', 'GHIJKL', 'MN']);
  });
});

suite('sync client state', () => {
  const panel: SyncPanel = { state: 'unpaired', defaultName: 'desk' };

  test('starts off with no panel and no open request', () => {
    assert.strictEqual(initialState.syncStatus, 'off');
    assert.strictEqual(initialState.syncPanel, undefined);
    assert.strictEqual(initialState.syncOpenRequest, 0);
  });

  test('sync-panel and sync-status are stored', () => {
    const s = reduce(reduce(initialState, { t: 'sync-panel', panel }), { t: 'sync-status', status: 'offline' });
    assert.deepStrictEqual(s.syncPanel, panel);
    assert.strictEqual(s.syncStatus, 'offline');
  });

  test('both open requests count, and hydrate keeps the count but takes its own status', () => {
    const opened = reduce(reduce(initialState, { t: 'open-sync' }), { t: 'local-open-sync' });
    assert.strictEqual(opened.syncOpenRequest, 2);
    const fresh = reduce(reduce(opened, { t: 'sync-status', status: 'offline' }), hydrate('ok'));
    assert.strictEqual(fresh.syncOpenRequest, 2);
    assert.strictEqual(fresh.syncStatus, 'ok');
    assert.strictEqual(reduce(opened, hydrate()).syncStatus, 'off');
  });
});

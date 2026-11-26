import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { parsePickerCommand } from '../../tui/view/pickers';
import { syncKey, type SyncKeyContext } from '../../tui/view/sync-keys';

const rows: SyncKeyContext['rows'] = [
  { kind: 'device', deviceId: 'd-self', self: true, revoked: false },
  { kind: 'device', deviceId: 'd-lap', self: false, revoked: false },
  { kind: 'device', deviceId: 'd-old', self: false, revoked: true, unfinishedRevoke: true },
  { kind: 'project', path: '/w/a', choice: 'shared' },
];
const ctx = (over: Partial<SyncKeyContext> = {}): SyncKeyContext => ({ rows, index: 0, busy: false, ...over });

suite('tui sync keys', () => {
  test('arrows move within the rows', () => {
    assert.deepStrictEqual(syncKey('down', ctx()), { t: 'move', index: 1 });
    assert.deepStrictEqual(syncKey('down', ctx({ index: 3 })), { t: 'move', index: 3 });
    assert.deepStrictEqual(syncKey('up', ctx()), { t: 'move', index: 0 });
  });

  test('r asks before revoking another device, and finishes an unfinished revoke at once', () => {
    assert.strictEqual(syncKey('r', ctx()), undefined);
    assert.deepStrictEqual(syncKey('r', ctx({ index: 1 })), { t: 'confirm', what: { t: 'revoke', deviceId: 'd-lap' } });
    assert.deepStrictEqual(syncKey('r', ctx({ index: 2 })), { t: 'revoke', deviceId: 'd-old' });
  });

  test('y confirms, n and escape cancel', () => {
    const confirming = ctx({ confirming: { t: 'revoke', deviceId: 'd-lap' } });
    assert.deepStrictEqual(syncKey('y', confirming), { t: 'revoke', deviceId: 'd-lap' });
    assert.deepStrictEqual(syncKey('n', confirming), { t: 'cancel' });
    assert.deepStrictEqual(syncKey('escape', confirming), { t: 'cancel' });
    assert.deepStrictEqual(syncKey('y', ctx({ confirming: { t: 'leave' } })), { t: 'leave' });
  });

  test('p pairs, l asks to leave, g retries, escape closes; nothing while busy except closing', () => {
    assert.deepStrictEqual(syncKey('p', ctx()), { t: 'pair' });
    assert.deepStrictEqual(syncKey('l', ctx()), { t: 'confirm', what: { t: 'leave' } });
    assert.deepStrictEqual(syncKey('g', ctx()), { t: 'refresh' });
    assert.deepStrictEqual(syncKey('escape', ctx()), { t: 'close' });
    assert.strictEqual(syncKey('p', ctx({ busy: true })), undefined);
    assert.deepStrictEqual(syncKey('escape', ctx({ busy: true })), { t: 'close' });
  });

  test('on a project row, s shares and k keeps it separate', () => {
    assert.deepStrictEqual(syncKey('k', ctx({ index: 3 })), { t: 'project', path: '/w/a', choice: 'own' });
    assert.deepStrictEqual(syncKey('s', ctx({ index: 3 })), { t: 'project', path: '/w/a', choice: 'shared' });
    assert.strictEqual(syncKey('k', ctx({ index: 1 })), undefined);
  });
});

suite('tui /sync', () => {
  test('/sync opens the sync picker', () => {
    assert.strictEqual(parsePickerCommand('/sync'), 'sync');
    assert.strictEqual(parsePickerCommand('/sync now'), undefined);
  });
});

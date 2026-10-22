import * as assert from 'assert';
import { mcpListKey } from '../../tui/view/mcp-keys';
import { mcpRows, type McpRow } from '../../client-core/mcp/mcp-rows';
import { parsePickerCommand } from '../../tui/view/pickers';

const row = (over: Partial<McpRow> = {}): McpRow => ({
  name: 'shadcn', state: 'connected', badge: 'repo', detail: '', canReconnect: true, canRemove: true, canSignIn: false,
  removeOrigin: 'repo', ...over,
});
const ctx = (over: Partial<Parameters<typeof mcpListKey>[1]> = {}) => ({
  rows: [row(), row({ name: 'figma', state: 'failed' as const, canSignIn: true })], index: 0, pending: false, canAdd: true, ...over,
});

suite('tui mcp keys while restarting', () => {
  test('r, s and d do nothing while the session restarts', () => {
    const caps = { reconnect: 'per-server' as const, signIn: true, sse: true, workingDirectory: false };
    const rows = mcpRows(
      [{ name: 'a', state: 'needs-auth', origin: 'repo', canSignIn: true }],
      { capabilities: caps, targets: null, pending: [], restarting: true },
    );
    for (const key of ['r', 's', 'd']) {
      assert.strictEqual(mcpListKey(key, { rows, index: 0, pending: false, canAdd: true }), undefined);
    }
  });
});

suite('tui mcp keys', () => {
  test('/mcp is a picker command', () => {
    assert.strictEqual(parsePickerCommand('/mcp'), 'mcp');
    assert.strictEqual(parsePickerCommand('/mcp reconnect github'), 'mcp');
    assert.strictEqual(parsePickerCommand('/mcpx'), undefined);
    assert.strictEqual(parsePickerCommand('/model x'), undefined);
  });

  test('arrows move within the rows', () => {
    assert.deepStrictEqual(mcpListKey('down', ctx()), { t: 'move', index: 1 });
    assert.deepStrictEqual(mcpListKey('down', ctx({ index: 1 })), { t: 'move', index: 1 });
    assert.deepStrictEqual(mcpListKey('up', ctx()), { t: 'move', index: 0 });
  });

  test('r reconnects the selected row', () => {
    assert.deepStrictEqual(mcpListKey('r', ctx()), { t: 'reconnect', name: 'shadcn' });
  });

  test('R restarts only while a change is pending', () => {
    assert.strictEqual(mcpListKey('R', ctx()), undefined);
    assert.deepStrictEqual(mcpListKey('R', ctx({ pending: true })), { t: 'restart' });
  });

  test('d asks, y removes with the origin, n cancels', () => {
    assert.deepStrictEqual(mcpListKey('d', ctx()), { t: 'confirm-remove', name: 'shadcn' });
    assert.deepStrictEqual(mcpListKey('y', ctx({ confirming: 'shadcn' })), { t: 'remove', name: 'shadcn', origin: 'repo' });
    assert.deepStrictEqual(mcpListKey('n', ctx({ confirming: 'shadcn' })), { t: 'cancel' });
    assert.deepStrictEqual(mcpListKey('r', ctx({ confirming: 'shadcn' })), undefined);
  });

  test('d on a row that cannot be removed does nothing', () => {
    assert.strictEqual(mcpListKey('d', ctx({ rows: [row({ canRemove: false, removeOrigin: undefined })] })), undefined);
  });

  test('s signs in only where offered', () => {
    assert.strictEqual(mcpListKey('s', ctx()), undefined);
    assert.deepStrictEqual(mcpListKey('s', ctx({ index: 1 })), { t: 'sign-in', name: 'figma' });
  });

  test('a adds when the provider can manage, escape closes', () => {
    assert.deepStrictEqual(mcpListKey('a', ctx()), { t: 'add' });
    assert.strictEqual(mcpListKey('a', ctx({ canAdd: false })), undefined);
    assert.deepStrictEqual(mcpListKey('escape', ctx()), { t: 'close' });
  });
});

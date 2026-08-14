import * as assert from 'assert';
import { aggregateServers, isUnhealthy, worstState } from '../../webview/components/mcp-status';

suite('mcp status rollup', () => {
  test('no servers means no state to report', () => {
    assert.strictEqual(worstState([]), undefined);
  });

  test('all connected reports connected', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'connected' }, { name: 'b', state: 'connected' },
    ]), 'connected');
  });

  test('failed outranks connected, pending and needs-auth', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'connected' },
      { name: 'b', state: 'pending' },
      { name: 'c', state: 'needs-auth' },
      { name: 'd', state: 'failed' },
    ]), 'failed');
  });

  test('needs-auth outranks pending and disabled', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'pending' },
      { name: 'b', state: 'disabled' },
      { name: 'c', state: 'needs-auth' },
    ]), 'needs-auth');
  });

  test('disabled is not treated as a problem', () => {
    assert.strictEqual(worstState([
      { name: 'a', state: 'connected' }, { name: 'b', state: 'disabled' },
    ]), 'connected');
    assert.strictEqual(isUnhealthy('disabled'), false);
    assert.strictEqual(isUnhealthy('pending'), false);
    assert.strictEqual(isUnhealthy('connected'), false);
    assert.strictEqual(isUnhealthy('failed'), true);
    assert.strictEqual(isUnhealthy('needs-auth'), true);
  });

  test('aggregation dedupes by name and keeps the worst report', () => {
    const merged = aggregateServers({
      s1: { mcpServers: [
        { name: 'github', state: 'connected', toolCount: 12 },
        { name: 'stripe', state: 'connected' },
      ] },
      s2: { mcpServers: [
        { name: 'github', state: 'failed', error: 'spawn ENOENT' },
      ] },
    });
    assert.strictEqual(merged.length, 2);
    const github = merged.find((s) => s.name === 'github');
    assert.strictEqual(github?.state, 'failed');
    assert.strictEqual(github?.error, 'spawn ENOENT');
  });

  test('aggregation keeps a tool count the worse report lacks', () => {
    const merged = aggregateServers({
      s1: { mcpServers: [{ name: 'github', state: 'connected', toolCount: 12 }] },
      s2: { mcpServers: [{ name: 'github', state: 'pending' }] },
    });
    assert.strictEqual(merged[0].state, 'pending');
    assert.strictEqual(merged[0].toolCount, 12);
  });

  test('aggregation is sorted worst-first, then by name', () => {
    const merged = aggregateServers({
      s1: { mcpServers: [
        { name: 'zulip', state: 'connected' },
        { name: 'alpha', state: 'connected' },
        { name: 'stripe', state: 'failed' },
      ] },
    });
    assert.deepStrictEqual(merged.map((s) => s.name), ['stripe', 'alpha', 'zulip']);
  });

  test('no panes means nothing to report', () => {
    assert.deepStrictEqual(aggregateServers({}), []);
  });
});

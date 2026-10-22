import * as assert from 'assert';
import { withPanelCommands } from '../../client-core/invocables/panel-commands';

suite('withPanelCommands', () => {
  test('no provider list means no menu at all', () => {
    assert.deepStrictEqual(withPanelCommands(undefined), []);
  });

  test('appends the panel /mcp after the provider entries', () => {
    assert.deepStrictEqual(withPanelCommands([{ name: 'compact' }]).map((e) => e.name), ['compact', 'mcp']);
  });

  test("replaces a provider's own /mcp, dropping its argument hint", () => {
    const out = withPanelCommands([
      { name: 'mcp', description: 'Manage MCP servers', argHint: '[reconnect|enable|disable [<server>|all]]', bare: true },
      { name: 'compact' },
    ]);
    assert.deepStrictEqual(out.map((e) => e.name), ['compact', 'mcp']);
    assert.strictEqual(out[1].argHint, undefined);
    assert.strictEqual(out[1].description, "Manage this session's MCP servers");
  });
});

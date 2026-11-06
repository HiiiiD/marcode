import * as assert from 'assert';
import { buildSpawnPreamble } from '../../host/self-control/spawn-preamble';

suite('buildSpawnPreamble', () => {
  test('names the parent as the report-back target', () => {
    const text = buildSpawnPreamble({ parent: 'claude-abc' });
    assert.strictEqual(text.includes('spawned by session "claude-abc"'), true);
    assert.strictEqual(text.includes('marcode__send_message to "claude-abc"'), true);
  });

  test('is pure: same input, same output', () => {
    assert.strictEqual(buildSpawnPreamble({ parent: 'p' }), buildSpawnPreamble({ parent: 'p' }));
  });
});

import * as assert from 'assert';
import { parseWorkerMessage } from '../../webview/lib/worker-message';

suite('parseWorkerMessage', () => {
  test('strips the settle header and previews the first real line', () => {
    const r = parseWorkerMessage('Subagent "claude-ab12" finished:\n\n## Done\nlong body');
    assert.strictEqual(r.label, 'Reply');
    assert.strictEqual(r.preview, 'Done');
    assert.strictEqual(r.body.startsWith('## Done'), true);
  });

  test('a failure is labelled as one', () => {
    assert.strictEqual(parseWorkerMessage('Subagent "x" failed:\nboom').label, 'Failed');
  });

  test('any other message is kept whole', () => {
    const r = parseWorkerMessage('need a decision');
    assert.deepStrictEqual([r.label, r.body], ['Message', 'need a decision']);
  });
});

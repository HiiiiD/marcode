import * as assert from 'assert';
import { chipLabel } from '../../webview/components/editor-context-chip';

suite('chipLabel', () => {
  test('a file reference is the basename alone', () => {
    assert.strictEqual(
      chipLabel({ path: 'src/host/agent-session.ts', languageId: 'typescript' }),
      'agent-session.ts',
    );
  });

  test('one range appends the line span', () => {
    assert.strictEqual(chipLabel({
      path: 'src/host/agent-session.ts',
      languageId: 'typescript',
      selection: { ranges: [{ startLine: 60, endLine: 73, text: 'x' }], truncated: false },
    }), 'agent-session.ts:60-73');
  });

  test('a single-line range collapses to one number', () => {
    assert.strictEqual(chipLabel({
      path: 'a.ts',
      languageId: 'typescript',
      selection: { ranges: [{ startLine: 7, endLine: 7, text: 'x' }], truncated: false },
    }), 'a.ts:7');
  });

  test('extra ranges are counted, not listed', () => {
    assert.strictEqual(chipLabel({
      path: 'a.ts',
      languageId: 'typescript',
      selection: {
        ranges: [
          { startLine: 1, endLine: 2, text: 'x' },
          { startLine: 9, endLine: 9, text: 'y' },
          { startLine: 20, endLine: 21, text: 'z' },
        ],
        truncated: false,
      },
    }), 'a.ts:1-2 +2');
  });
});

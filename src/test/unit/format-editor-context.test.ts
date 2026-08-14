import * as assert from 'assert';
import { formatEditorContext } from '../../providers/format-editor-context';

suite('formatEditorContext', () => {
  test('no selection renders a self-closing reference', () => {
    const out = formatEditorContext({ path: 'src/a.ts', languageId: 'typescript' });
    assert.strictEqual(out, '<editor-context path="src/a.ts" language="typescript" />');
  });

  test('one range renders a body', () => {
    const out = formatEditorContext({
      path: 'src/a.ts',
      languageId: 'typescript',
      selection: {
        ranges: [{ startLine: 60, endLine: 61, text: 'const a = 1;\nconst b = 2;' }],
        truncated: false,
      },
    });
    assert.strictEqual(out, [
      '<editor-context path="src/a.ts" language="typescript">',
      '<range lines="60-61">',
      'const a = 1;',
      'const b = 2;',
      '</range>',
      '</editor-context>',
    ].join('\n'));
  });

  test('several ranges and truncation are both visible to the model', () => {
    const out = formatEditorContext({
      path: 'src/a.ts',
      languageId: 'typescript',
      selection: {
        ranges: [
          { startLine: 1, endLine: 1, text: 'one' },
          { startLine: 9, endLine: 9, text: 'two' },
        ],
        truncated: true,
      },
    });
    assert.ok(out.startsWith('<editor-context path="src/a.ts" language="typescript" truncated="true">'));
    assert.ok(out.includes('<range lines="1-1">\none\n</range>'));
    assert.ok(out.includes('<range lines="9-9">\ntwo\n</range>'));
  });

  test('quotes and angle brackets in a path cannot break out of the attribute', () => {
    const out = formatEditorContext({ path: 'a"><b.ts', languageId: 'plaintext' });
    assert.ok(!out.includes('a"><b.ts'));
    assert.ok(out.includes('a&quot;&gt;&lt;b.ts'));
  });
});

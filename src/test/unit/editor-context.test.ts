import * as assert from 'assert';
import * as path from 'path';
import {
  SELECTION_BUDGET, toEditorContext, type EditorSnapshot,
} from '../../host/editor-context';

const ROOT = path.resolve('/work/repo');

function snap(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    fsPath: path.join(ROOT, 'src', 'a.ts'),
    scheme: 'file',
    languageId: 'typescript',
    ranges: [],
    ...over,
  };
}

suite('toEditorContext', () => {
  test('a non-file scheme produces no context', () => {
    assert.strictEqual(toEditorContext(snap({ scheme: 'untitled' }), [ROOT]), null);
    assert.strictEqual(toEditorContext(snap({ scheme: 'output' }), [ROOT]), null);
  });

  test('no selection yields a file reference with no selection field', () => {
    const ctx = toEditorContext(snap(), [ROOT]);
    assert.ok(ctx);
    assert.strictEqual(ctx.path, 'src/a.ts');
    assert.strictEqual(ctx.languageId, 'typescript');
    assert.strictEqual(ctx.selection, undefined);
  });

  test('empty ranges are dropped, leaving a file reference', () => {
    const ctx = toEditorContext(snap({
      ranges: [{ startLine: 4, endLine: 4, text: '' }],
    }), [ROOT]);
    assert.ok(ctx);
    assert.strictEqual(ctx.selection, undefined);
  });

  test('a path outside every workspace root stays absolute', () => {
    const outside = path.resolve('/elsewhere/b.ts');
    const ctx = toEditorContext(snap({ fsPath: outside }), [ROOT]);
    assert.ok(ctx);
    assert.strictEqual(ctx.path, outside.replace(/\\/g, '/'));
  });

  test('the longest matching root wins', () => {
    const nested = path.resolve('/work/repo/packages/app');
    const ctx = toEditorContext(snap({
      fsPath: path.join(nested, 'src', 'a.ts'),
    }), [ROOT, nested]);
    assert.ok(ctx);
    assert.strictEqual(ctx.path, 'src/a.ts');
  });

  test('ranges are sorted by start line', () => {
    const ctx = toEditorContext(snap({
      ranges: [
        { startLine: 40, endLine: 41, text: 'later' },
        { startLine: 10, endLine: 11, text: 'earlier' },
      ],
    }), [ROOT]);
    assert.deepStrictEqual(ctx?.selection?.ranges, [
      { startLine: 10, endLine: 11, text: 'earlier' },
      { startLine: 40, endLine: 41, text: 'later' },
    ]);
    assert.strictEqual(ctx?.selection?.truncated, false);
  });

  test('adjacent and overlapping ranges merge into one', () => {
    const ctx = toEditorContext(snap({
      ranges: [
        { startLine: 10, endLine: 12, text: 'a' },
        { startLine: 13, endLine: 14, text: 'b' },
        { startLine: 30, endLine: 30, text: 'c' },
      ],
    }), [ROOT]);
    assert.deepStrictEqual(ctx?.selection?.ranges, [
      { startLine: 10, endLine: 14, text: 'a\nb' },
      { startLine: 30, endLine: 30, text: 'c' },
    ]);
  });

  test('a range past the budget is cut and its end line recomputed', () => {
    const big = 'x'.repeat(SELECTION_BUDGET + 500);
    const ctx = toEditorContext(snap({
      ranges: [{ startLine: 1, endLine: 900, text: big }],
    }), [ROOT]);
    assert.strictEqual(ctx?.selection?.ranges.length, 1);
    assert.strictEqual(ctx?.selection?.ranges[0].text.length, SELECTION_BUDGET);
    assert.strictEqual(ctx?.selection?.ranges[0].endLine, 1);
    assert.strictEqual(ctx?.selection?.truncated, true);
  });

  test('ranges past the budget are dropped, earlier ones kept whole', () => {
    const ctx = toEditorContext(snap({
      ranges: [
        { startLine: 1, endLine: 2, text: 'y'.repeat(SELECTION_BUDGET) },
        { startLine: 50, endLine: 51, text: 'dropped' },
      ],
    }), [ROOT]);
    assert.strictEqual(ctx?.selection?.ranges.length, 1);
    assert.strictEqual(ctx?.selection?.ranges[0].startLine, 1);
    assert.strictEqual(ctx?.selection?.truncated, true);
  });
});

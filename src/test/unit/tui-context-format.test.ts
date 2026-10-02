import * as assert from 'node:assert';
import {
  clampPercent, contextModel, DANGER_PERCENT, fitPath, headerLabel, stackedBar,
} from '../../client-core/context-format';
import { formatTokens } from '../../client-core/format-tokens';
import { breakdown } from '../fixtures/protocol';

const sum = (cells: { cells: number }[]) => cells.reduce((n, c) => n + c.cells, 0);

suite('context-format: model', () => {
  test('slices come in fixed order and are clamped and rounded', () => {
    const m = contextModel(breakdown({ systemPercent: 12.4, memoryPercent: -3, conversationPercent: 140, freePercent: 57 }));
    assert.deepStrictEqual(m.slices.map((s) => [s.key, s.percent]), [
      ['system', 12], ['memory', 0], ['conversation', 100], ['free', 57],
    ]);
  });
  test('a memory file under 1% reads <1%, never 0%', () => {
    const m = contextModel(breakdown({ memoryFiles: [{ path: '/a/CLAUDE.md', percent: 0 }, { path: '/b/X.md', percent: 3 }] }));
    assert.deepStrictEqual(m.memoryFiles.map((f) => f.percent), ['<1%', '3%']);
  });
  test('the window line needs both token fields', () => {
    assert.strictEqual(contextModel(breakdown({ usedTokens: 43000, windowTokens: 258000 })).window, '43K of 258K tokens');
    assert.strictEqual(contextModel(breakdown({ usedTokens: 43000 })).window, undefined);
    assert.strictEqual(contextModel(breakdown({ windowTokens: 258000 })).window, undefined);
    assert.strictEqual(contextModel(breakdown()).window, undefined);
  });
});

suite('context-format: stacked bar', () => {
  const four = (s: number, m: number, c: number, f: number) => [
    { key: 'system' as const, percent: s }, { key: 'memory' as const, percent: m },
    { key: 'conversation' as const, percent: c }, { key: 'free' as const, percent: f },
  ];
  test('cells always add up to the width', () => {
    for (const w of [10, 33, 40]) {
      assert.strictEqual(sum(stackedBar(four(12, 4, 27, 57), w)), w);
      assert.strictEqual(sum(stackedBar(four(33, 33, 33, 1), w)), w);
    }
  });
  test('a nonzero slice never rounds away, and a zero slice gets no cell', () => {
    const cells = stackedBar(four(0, 0, 2, 98), 20);
    assert.strictEqual(cells.find((c) => c.key === 'conversation')!.cells >= 1, true);
    assert.strictEqual(cells.find((c) => c.key === 'system')!.cells, 0);
    assert.strictEqual(sum(cells), 20);
  });
  test('all zeros draw an empty bar', () => {
    assert.strictEqual(sum(stackedBar(four(0, 0, 0, 0), 20)), 0);
  });
});

suite('context-format: paths, header, tokens', () => {
  test('fitPath keeps the basename and trims the front', () => {
    assert.strictEqual(fitPath('/repo/CLAUDE.md', 40), '/repo/CLAUDE.md');
    assert.strictEqual(fitPath('/very/long/dir/name/CLAUDE.md', 14), '…ame/CLAUDE.md');
    assert.strictEqual(fitPath('/very/long/dir/name/CLAUDE.md', 14).length, 14);
    assert.strictEqual(fitPath('/x/y.md', 1), '…');
  });
  test('header is unavailable without a percent and dangerous at 80', () => {
    assert.deepStrictEqual(headerLabel(undefined), { text: 'unavailable', danger: false });
    assert.deepStrictEqual(headerLabel(DANGER_PERCENT - 1), { text: '79% used', danger: false });
    assert.deepStrictEqual(headerLabel(DANGER_PERCENT), { text: '80% used', danger: true });
  });
  test('clampPercent bounds and rounds', () => {
    assert.strictEqual(clampPercent(-5), 0);
    assert.strictEqual(clampPercent(100.6), 100);
    assert.strictEqual(clampPercent(41.5), 42);
  });
  test('formatTokens is the webview formatter, moved', () => {
    assert.strictEqual(formatTokens(999), '999');
    assert.strictEqual(formatTokens(258000), '258K');
  });
});

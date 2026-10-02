import * as assert from 'node:assert';
import type { UsageWindow } from '../../providers/types';
import {
  BAR_CELLS, resetCountdown, stripLines, usageRows, windowLine, windowLineText, type UsageWindowRow,
} from '../../client-core/usage-format';

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const name = (id: string) => id.toUpperCase();
const win = (over: Partial<UsageWindow> = {}): UsageWindow => ({ id: 'five-hour', label: 'Session (5h)', usedPercent: 62, ...over });

suite('usage-format: resetCountdown', () => {
  test('compact units, floored', () => {
    assert.strictEqual(resetCountdown(NOW + 30_000, NOW), '<1m');
    assert.strictEqual(resetCountdown(NOW + 45 * MIN, NOW), '45m');
    assert.strictEqual(resetCountdown(NOW + (2 * 60 + 14) * MIN, NOW), '2h14m');
    assert.strictEqual(resetCountdown(NOW + 120 * MIN, NOW), '2h00m');
    assert.strictEqual(resetCountdown(NOW + (3 * 24 + 4) * 60 * MIN, NOW), '3d4h');
  });
  test('unknown, past and exactly-now give nothing', () => {
    assert.strictEqual(resetCountdown(undefined, NOW), undefined);
    assert.strictEqual(resetCountdown(NOW - 1, NOW), undefined);
    assert.strictEqual(resetCountdown(NOW, NOW), undefined);
  });
});

suite('usage-format: usageRows', () => {
  test('providers with no windows or only expired ones produce no row', () => {
    const rows = usageRows({ a: [], b: undefined, c: [win({ resetsAt: NOW - 1 })], d: [win()] }, name, NOW);
    assert.deepStrictEqual(rows.map((r) => r.id), ['d']);
  });
  test('windows come in the shared order, with short labels and clamped percents', () => {
    const rows = usageRows({ p: [
      win({ id: 'seven-day', label: 'Week', usedPercent: 140.4 }),
      win({ id: 'five-hour', usedPercent: -3, resetsAt: NOW + 62 * MIN }),
      win({ id: 'mystery', label: 'Credits', usedPercent: 41.5 }),
    ] }, name, NOW);
    assert.deepStrictEqual(rows[0]!.windows, [
      { id: 'five-hour', label: '5h', percent: 0, reset: '1h02m' },
      { id: 'seven-day', label: '7d', percent: 100 },
      { id: 'mystery', label: 'Credits', percent: 42 },
    ]);
    assert.strictEqual(rows[0]!.name, 'P');
  });
  test('a window with no resetsAt never expires', () => {
    assert.strictEqual(usageRows({ p: [win({ resetsAt: undefined })] }, name, NOW).length, 1);
  });
});

suite('usage-format: windowLine', () => {
  const row: UsageWindowRow = { id: 'five-hour', label: '5h', percent: 62, reset: '1h02m' };
  test('everything fits at the roster width', () => {
    const l = windowLine(row, 24, 2);
    assert.strictEqual(windowLineText(l), '5h ████░░ 62% 1h02m');
    assert.strictEqual(l.filled, 4);
  });
  test('loss order: countdown, then label, then bar', () => {
    assert.strictEqual(windowLineText(windowLine(row, 14, 2)), '5h ████░░ 62%');
    const long: UsageWindowRow = { ...row, label: 'Credits' };
    assert.strictEqual(windowLineText(windowLine(long, 14, 7)), 'Cr… ████░░ 62%');
    assert.strictEqual(windowLineText(windowLine(long, 9, 7)), 'Cred… 62%');
    assert.strictEqual(windowLineText(windowLine(row, 3, 2)), '62%');
  });
  test('the printed line never exceeds the width, at any width', () => {
    for (const r of [row, { ...row, label: 'a very long window label', percent: 100 }, { ...row, percent: 0, reset: undefined }]) {
      for (let w = 0; w <= 60; w++) {
        assert.strictEqual(windowLineText(windowLine(r, w, Math.min(r.label.length, 8))).length <= w, true, `width ${w}`);
      }
    }
  });
  test('a nonzero percent always lights at least one cell, zero lights none', () => {
    assert.strictEqual(windowLine({ ...row, percent: 1 }, 40, 2).filled, 1);
    assert.strictEqual(windowLine({ ...row, percent: 0 }, 40, 2).filled, 0);
    assert.strictEqual(windowLine({ ...row, percent: 100 }, 40, 2).filled, BAR_CELLS);
  });
});

suite('usage-format: stripLines', () => {
  const rows = usageRows({
    a: [win(), win({ id: 'seven-day', label: 'Week', usedPercent: 18 })],
    b: [win({ usedPercent: 9 })],
  }, name, NOW);
  test('a name line per provider then its windows, label column aligned', () => {
    const lines = stripLines(rows, 24, 20);
    assert.deepStrictEqual(lines.map((l) => (l.kind === 'provider' ? l.text : windowLineText(l.line))),
      ['A', '5h ████░░ 62%', '7d █░░░░░ 18%', 'B', '5h █░░░░░ 9%']);
  });
  test('maxLines cuts from the end and never exceeds the width', () => {
    assert.strictEqual(stripLines(rows, 24, 3).length, 3);
    assert.strictEqual(stripLines(rows, 24, 0).length, 0);
    const long = usageRows({ p: [win()] }, () => 'A provider with a very long display name', NOW);
    const first = stripLines(long, 10, 5)[0]!;
    assert.strictEqual(first.kind === 'provider' && first.text.length <= 10, true);
  });
  test('no rows, no lines', () => {
    assert.deepStrictEqual(stripLines([], 24, 5), []);
  });
});

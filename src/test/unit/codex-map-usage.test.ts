import * as assert from 'assert';
import { toContextBreakdown, toUsageWindows } from '../../providers/codex/map-usage';

suite('toUsageWindows', () => {
  test('names a window from its duration', () => {
    const windows = toUsageWindows({
      primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: null },
      secondary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: null },
    });
    assert.deepStrictEqual(windows.map((w) => [w.id, w.label, w.usedPercent]), [
      ['primary', 'Session (5h)', 62],
      ['secondary', 'Week', 18],
    ]);
  });

  test('falls back to a generic label when the duration is unknown', () => {
    const [window] = toUsageWindows({
      primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null },
      secondary: null,
    });
    assert.strictEqual(window.label, 'Plan usage');
  });

  test('an absent window is omitted, not zeroed', () => {
    // A missing window is "not reported", which is different from "0% used".
    assert.deepStrictEqual(toUsageWindows({ primary: null, secondary: null }), []);
  });

  test('resetsAt is converted from epoch seconds to epoch ms', () => {
    // MEASURED, not assumed. account/rateLimits/read on codex-cli 0.147.0
    // returned resetsAt 1787337648 against a wall clock of 1786736436s on
    // 2026-08-14 — 6.96 days out on a 10080-minute window, which is epoch
    // seconds. UsageWindow.resetsAt is epoch ms, hence the conversion.
    // Re-measure if the pinned CLI version moves.
    const [window] = toUsageWindows({
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_337_648 },
      secondary: null,
    });
    assert.strictEqual(window.resetsAt, 1_787_337_648_000);
  });

  test('a plus account reporting only a weekly window yields one row', () => {
    // Observed shape: primary is the weekly window and secondary is null.
    // The strip must render one row, not one row and a blank.
    const windows = toUsageWindows({
      primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_787_337_648 },
      secondary: null,
    });
    assert.deepStrictEqual(windows.map((w) => w.label), ['Week']);
  });
});

suite('toContextBreakdown', () => {
  test('reports percentages of the context window, never tokens', () => {
    const breakdown = toContextBreakdown({
      total: { totalTokens: 50_000, inputTokens: 40_000, cachedInputTokens: 0,
               outputTokens: 10_000, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 200_000,
    });
    assert.deepStrictEqual(breakdown, {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 25, freePercent: 75,
      memoryFiles: [],
    });
  });

  test('the four percentages always sum to 100', () => {
    const breakdown = toContextBreakdown({
      total: { totalTokens: 33_333, inputTokens: 33_333, cachedInputTokens: 0,
               outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 100_000,
    })!;
    const sum = breakdown.systemPercent + breakdown.memoryPercent
      + breakdown.conversationPercent + breakdown.freePercent;
    assert.strictEqual(sum, 100);
  });

  test('no context window means no breakdown at all', () => {
    // A provider that cannot report must omit rather than fabricate.
    assert.strictEqual(toContextBreakdown({
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0,
               outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
              outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: null,
    }), undefined);
  });
});

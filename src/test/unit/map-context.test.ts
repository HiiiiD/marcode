import * as assert from 'assert';
import { toContextBreakdown, toUsageWindows } from '../../providers/claude/map-context';

suite('map-context', () => {
  test('splits the window into system, memory, conversation and free', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 40_000,
      maxTokens: 200_000,
      memoryFiles: [
        { path: '/repo/CLAUDE.md', type: 'project', tokens: 6_000 },
        { path: '/home/u/.claude/CLAUDE.md', type: 'user', tokens: 2_000 },
      ],
      messageBreakdown: {
        toolCallTokens: 4_000, toolResultTokens: 6_000, attachmentTokens: 0,
        assistantMessageTokens: 5_000, userMessageTokens: 1_000,
        redirectedContextTokens: 0, unattributedTokens: 0,
      },
    });

    assert.strictEqual(breakdown.memoryPercent, 4);
    assert.strictEqual(breakdown.conversationPercent, 8);
    assert.strictEqual(breakdown.systemPercent, 8);
    assert.strictEqual(breakdown.freePercent, 80);
    assert.deepStrictEqual(breakdown.memoryFiles, [
      { path: '/repo/CLAUDE.md', percent: 3 },
      { path: '/home/u/.claude/CLAUDE.md', percent: 1 },
    ]);
  });

  test('the four slices always sum to 100', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 33_333, maxTokens: 100_000, memoryFiles: [], messageBreakdown: undefined,
    });
    const sum = breakdown.systemPercent + breakdown.memoryPercent
      + breakdown.conversationPercent + breakdown.freePercent;
    assert.strictEqual(sum, 100);
  });

  test('a sub-one-percent memory file keeps its row at 0, for the UI to render as <1%', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 300, maxTokens: 200_000,
      memoryFiles: [{ path: '/repo/AGENTS.md', type: 'project', tokens: 300 }],
      messageBreakdown: undefined,
    });
    assert.deepStrictEqual(breakdown.memoryFiles, [{ path: '/repo/AGENTS.md', percent: 0 }]);
  });

  test('a zero or missing window budget reports everything free', () => {
    const breakdown = toContextBreakdown({
      totalTokens: 10, maxTokens: 0, memoryFiles: [], messageBreakdown: undefined,
    });
    assert.deepStrictEqual(breakdown, {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 0, freePercent: 100,
      memoryFiles: [],
    });
  });

  test('maps the plan windows that report a utilization, in a stable order', () => {
    const windows = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 62, resets_at: '2026-08-13T18:00:00.000Z' },
        seven_day: { utilization: 18, resets_at: null },
        seven_day_opus: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: null }],
      },
    });

    assert.deepStrictEqual(windows, [
      {
        id: 'five-hour', label: 'Session (5h)', usedPercent: 62,
        resetsAt: Date.parse('2026-08-13T18:00:00.000Z'),
      },
      { id: 'seven-day', label: 'Week', usedPercent: 18 },
      { id: 'model:Fable', label: 'Week (Fable)', usedPercent: 5 },
    ]);
  });

  test('reports no windows when plan limits do not apply', () => {
    assert.deepStrictEqual(
      toUsageWindows({ rate_limits_available: false, rate_limits: null }),
      [],
    );
  });
});

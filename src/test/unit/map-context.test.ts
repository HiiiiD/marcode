import * as assert from 'assert';
import { toContextBreakdown, toUsageWindow, toUsageWindows } from '../../providers/claude/map-context';

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

  test('an unknown window budget keeps the memory rows it cannot size', () => {
    // Dropping them renders "No memory files loaded", which says something
    // false about the session — the files were loaded; it is the
    // denominator that is missing.
    const breakdown = toContextBreakdown({
      totalTokens: 10, maxTokens: 0,
      memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'project', tokens: 10 }],
      messageBreakdown: undefined,
    });

    assert.strictEqual(breakdown.freePercent, 100);
    assert.deepStrictEqual(breakdown.memoryFiles, [{ path: '/repo/CLAUDE.md', percent: 0 }]);
  });

  test('a near-full window where independently-rounded slices would overshoot still sums to 100', () => {
    // maxTokens=200, memoryTokens=65 (-> 33), conversationTokens=65 (-> 33),
    // totalTokens=199 so systemTokens=69 (-> 35): rounding each slice
    // independently sums to 101. This is a reachable near-full-context
    // state, not a synthetic edge case.
    const breakdown = toContextBreakdown({
      totalTokens: 199,
      maxTokens: 200,
      memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'project', tokens: 65 }],
      messageBreakdown: {
        toolCallTokens: 65, toolResultTokens: 0, attachmentTokens: 0,
        assistantMessageTokens: 0, userMessageTokens: 0,
        redirectedContextTokens: 0, unattributedTokens: 0,
      },
    });
    const sum = breakdown.systemPercent + breakdown.memoryPercent
      + breakdown.conversationPercent + breakdown.freePercent;
    assert.strictEqual(sum, 100);
  });

  test('an under-shoot case (memory + conversation rounding above usedPercent) still sums to 100', () => {
    // maxTokens=200, memoryTokens=65 (-> 33), conversationTokens=65 (-> 33),
    // totalTokens=130 so systemTokens=0: usedPercent=65, but
    // memoryPercent+conversationPercent alone would round to 66 — one point
    // over usedPercent, which an earlier `max(0, used - memory - conversation)`
    // clamp silently discarded, leaving free=35 and a total of 101.
    const breakdown = toContextBreakdown({
      totalTokens: 130,
      maxTokens: 200,
      memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'project', tokens: 65 }],
      messageBreakdown: {
        toolCallTokens: 65, toolResultTokens: 0, attachmentTokens: 0,
        assistantMessageTokens: 0, userMessageTokens: 0,
        redirectedContextTokens: 0, unattributedTokens: 0,
      },
    });
    const sum = breakdown.systemPercent + breakdown.memoryPercent
      + breakdown.conversationPercent + breakdown.freePercent;
    assert.strictEqual(sum, 100);
  });

  test('the four slices sum to 100 across a spread of token combinations', () => {
    const maxTokensValues = [0, 1, 100, 200, 200_000];
    const partValues = [0, 1, 65, 100, 130, 300, 65_000, 130_000, 200_000, 250_000];

    for (const maxTokens of maxTokensValues) {
      for (const memoryTokens of partValues) {
        for (const conversationTokens of partValues) {
          for (const totalTokens of partValues) {
            const breakdown = toContextBreakdown({
              totalTokens,
              maxTokens,
              memoryFiles: memoryTokens > 0
                ? [{ path: '/repo/CLAUDE.md', type: 'project', tokens: memoryTokens }]
                : [],
              messageBreakdown: {
                toolCallTokens: conversationTokens, toolResultTokens: 0, attachmentTokens: 0,
                assistantMessageTokens: 0, userMessageTokens: 0,
                redirectedContextTokens: 0, unattributedTokens: 0,
              },
            });
            const sum = breakdown.systemPercent + breakdown.memoryPercent
              + breakdown.conversationPercent + breakdown.freePercent;
            assert.strictEqual(
              sum, 100,
              `maxTokens=${maxTokens} memoryTokens=${memoryTokens} `
              + `conversationTokens=${conversationTokens} totalTokens=${totalTokens} -> sum=${sum}`,
            );
          }
        }
      }
    }
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

suite('toUsageWindow', () => {
  test('maps a five-hour event to the table id and label', () => {
    assert.deepStrictEqual(
      toUsageWindow({ rateLimitType: 'five_hour', utilization: 62, resetsAt: 1_700_000_000_000 }),
      { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: 1_700_000_000_000 },
    );
  });

  test('rounds and clamps utilization into 0..100', () => {
    assert.strictEqual(toUsageWindow({ rateLimitType: 'seven_day', utilization: 18.4 })?.usedPercent, 18);
    assert.strictEqual(toUsageWindow({ rateLimitType: 'seven_day', utilization: 140 })?.usedPercent, 100);
    assert.strictEqual(toUsageWindow({ rateLimitType: 'seven_day', utilization: -3 })?.usedPercent, 0);
  });

  test('omits resetsAt rather than carrying a non-finite one', () => {
    const w = toUsageWindow({ rateLimitType: 'seven_day_opus', utilization: 5, resetsAt: Number.NaN });
    assert.deepStrictEqual(w, { id: 'seven-day-opus', label: 'Week (Opus)', usedPercent: 5 });
  });

  test('drops an event with no utilization — there is no percentage to show', () => {
    assert.strictEqual(toUsageWindow({ rateLimitType: 'five_hour' }), undefined);
  });

  test('drops an event with no rateLimitType, and the overage types, rather than guessing a label', () => {
    assert.strictEqual(toUsageWindow({ utilization: 40 }), undefined);
    assert.strictEqual(toUsageWindow({ rateLimitType: 'overage', utilization: 40 }), undefined);
    assert.strictEqual(
      toUsageWindow({ rateLimitType: 'seven_day_overage_included', utilization: 40 }), undefined,
    );
    assert.strictEqual(toUsageWindow(undefined), undefined);
  });
});

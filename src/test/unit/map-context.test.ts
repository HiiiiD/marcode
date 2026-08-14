import * as assert from 'assert';
import { toContextBreakdown, toUsageWindows, UsageResponseLike } from '../../providers/claude/map-context';

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

  test('memory rows sum to exactly memoryPercent', () => {
    const b = toContextBreakdown({
      totalTokens: 30_000, maxTokens: 100_000,
      memoryFiles: [
        { path: '/a', tokens: 3_333 }, { path: '/b', tokens: 3_333 }, { path: '/c', tokens: 3_334 },
      ],
    });
    assert.strictEqual(
      b.memoryFiles.reduce((sum, f) => sum + f.percent, 0), b.memoryPercent,
    );
  });

  test('no row exceeds its slice, even when the context is over-full', () => {
    const b = toContextBreakdown({
      totalTokens: 200_000, maxTokens: 100_000,
      memoryFiles: [{ path: '/big', tokens: 150_000 }],
    });
    assert.ok(b.memoryFiles[0].percent <= b.memoryPercent);
  });

  test('a file too small to round up still gets a row, at 0 — the UI reads it as <1%', () => {
    const b = toContextBreakdown({
      totalTokens: 50_000, maxTokens: 100_000,
      memoryFiles: [{ path: '/big', tokens: 49_000 }, { path: '/tiny', tokens: 1 }],
    });
    assert.strictEqual(b.memoryFiles.length, 2);
    assert.strictEqual(b.memoryFiles[1].percent, 0);
  });
});

suite('toUsageWindows', () => {
  test('maps a window, keeping utilization on its own 0-100 scale', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 62, resets_at: '2026-08-14T17:10:00Z' } },
    });
    assert.deepStrictEqual(out, [{
      id: 'five-hour',
      label: 'Session (5h)',
      usedPercent: 62,
      resetsAt: Date.parse('2026-08-14T17:10:00Z'),
    }]);
  });

  test('resets_at parses to epoch milliseconds, not seconds', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 10, resets_at: '2026-08-14T17:10:00Z' } },
    });
    // 1786727400000, not 1786727400 — a seconds value would be filtered as
    // already-reset by both windowsFor() and ProviderUsage.
    assert.strictEqual(out?.[0].resetsAt, 1786727400000);
  });

  test('rate_limits_available false is undefined, not an empty array', () => {
    // Distinct meanings: undefined is "this account has no plan limits at
    // all" (API key, Bedrock, Vertex) and clears persisted windows; [] is
    // "limits exist, nothing known yet" and does not.
    assert.strictEqual(
      toUsageWindows({ rate_limits_available: false, rate_limits: null }),
      undefined,
    );
  });

  test('available but null rate_limits is an empty array', () => {
    assert.deepStrictEqual(
      toUsageWindows({ rate_limits_available: true, rate_limits: null }),
      [],
    );
  });

  test('a null utilization drops that window but keeps its siblings', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: null, resets_at: '2026-08-14T17:10:00Z' },
        seven_day: { utilization: 18, resets_at: '2026-08-20T00:00:00Z' },
      },
    });
    assert.deepStrictEqual(out?.map((w) => w.id), ['seven-day']);
  });

  test('a null resets_at yields a window with no reset time', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 5, resets_at: null } },
    });
    assert.strictEqual(out?.[0].resetsAt, undefined);
    assert.strictEqual(out?.[0].usedPercent, 5);
  });

  test('an unparseable resets_at yields a window with no reset time', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: { seven_day: { utilization: 5, resets_at: 'not-a-date' } },
    });
    assert.strictEqual(out?.[0].resetsAt, undefined);
  });

  test('unlabelled keys are ignored rather than guessed at', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 3, resets_at: null },
        seven_day_oauth_apps: { utilization: 99, resets_at: null },
      } as UsageResponseLike['rate_limits'],
    });
    assert.deepStrictEqual(out?.map((w) => w.id), ['five-hour']);
  });

  test('utilization is clamped to 0-100 and rounded once', () => {
    const out = toUsageWindows({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 62.6, resets_at: null },
        seven_day: { utilization: 140, resets_at: null },
      },
    });
    assert.deepStrictEqual(out?.map((w) => w.usedPercent), [63, 100]);
  });

  test('an absent response is undefined', () => {
    assert.strictEqual(toUsageWindows(undefined), undefined);
  });
});

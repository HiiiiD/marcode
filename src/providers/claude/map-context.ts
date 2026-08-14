import type { ContextBreakdown, UsageWindow } from '../types';

/**
 * The subsets of the SDK's two response shapes this mapper reads. Declared
 * structurally rather than imported so the mapper — and its tests — stay
 * free of the ESM-only SDK types (see claude-provider.ts's header for why
 * those need `resolution-mode` gymnastics), and so a future SDK field
 * addition cannot break this module.
 */
export interface ContextUsageLike {
  totalTokens: number;
  maxTokens: number;
  memoryFiles: { path: string; type?: string; tokens: number }[];
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
  };
}

/**
 * Splits an integer `total` points across `parts` (proportionally to their
 * token weights) so the parts sum to exactly `total` — the largest-remainder
 * method. Rounding each part independently (`Math.round(part/base*total)`)
 * can over- or under-shoot `total` by a point or two; clamping the shortfall
 * onto one designated part (as an earlier version of this function did)
 * just moves the failure to a different input, since the clamp can go either
 * direction depending on which way the roundings happen to lean. Assigning
 * every part its floor and then handing the leftover points, one each, to
 * the parts with the largest fractional remainder is exact by construction
 * and needs no clamp. Ties break by array order — stable for any caller,
 * whether that is the fixed three-slice `[system, memory, conversation]`
 * call or the per-file, arbitrary-length `memoryFiles` call — so the output
 * is deterministic.
 */
function largestRemainder(weights: number[], base: number, total: number): number[] {
  if (base <= 0) { return weights.map(() => 0); }
  const exact = weights.map((w) => (w / base) * total);
  const floors = exact.map((e) => Math.floor(e));
  const used = floors.reduce((sum, f) => sum + f, 0);
  let remainder = total - used;
  const order = exact
    .map((e, i) => ({ i, frac: e - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) { break; }
    out[i] += 1;
    remainder -= 1;
  }
  return out;
}

/**
 * Tokens enter here and percentages leave: this is the only place in the
 * codebase allowed to reason in tokens for these surfaces. `usedPercent` —
 * the occupied share of the window — is rounded exactly once, so
 * `freePercent = 100 - usedPercent` is exact by definition; the three
 * attributed slices then split that same `usedPercent` via
 * `largestRemainder`, which sums to `usedPercent` by construction. The four
 * fields therefore always sum to exactly 100, regardless of how the
 * underlying token counts round.
 */
export function toContextBreakdown(res: ContextUsageLike): ContextBreakdown {
  const max = res.maxTokens;
  const memoryTokens = res.memoryFiles.reduce((sum, f) => sum + f.tokens, 0);
  const m = res.messageBreakdown;
  const conversationTokens = m
    ? m.toolCallTokens + m.toolResultTokens + m.attachmentTokens
      + m.assistantMessageTokens + m.userMessageTokens
      + m.redirectedContextTokens + m.unattributedTokens
    : 0;
  // Whatever the SDK counts in the total but does not attribute to memory
  // or messages is the system prompt and its tool definitions — the one
  // slice the spec folds together.
  const systemTokens = Math.max(0, res.totalTokens - memoryTokens - conversationTokens);
  const base = systemTokens + memoryTokens + conversationTokens;

  // No usable window size (or nothing attributed yet): every share is
  // unknown, which is 0 rather than a guess. The memory *rows* survive it
  // though — the files were loaded whatever the arithmetic says, and
  // dropping them would render "No memory files loaded", which is a claim
  // about the session rather than about the missing denominator.
  if (!Number.isFinite(max) || max <= 0 || base <= 0) {
    return {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 0, freePercent: 100,
      memoryFiles: res.memoryFiles.map((f) => ({ path: f.path, percent: 0 })),
    };
  }

  const usedPercent = Math.max(0, Math.min(100, Math.round((Math.min(base, max) / max) * 100)));
  const freePercent = 100 - usedPercent;
  const [systemPercent, memoryPercent, conversationPercent] = largestRemainder(
    [systemTokens, memoryTokens, conversationTokens], base, usedPercent,
  );

  // The rows are an allocation *within* the Memory slice, not an independent
  // tokens/maxTokens calculation. Sharing the slice's denominator is what
  // stops a single row from rendering larger than the slice it sits under
  // when the window is clamped or over-full.
  const filePercents = largestRemainder(
    res.memoryFiles.map((f) => f.tokens), memoryTokens, memoryPercent,
  );

  return {
    systemPercent,
    memoryPercent,
    conversationPercent,
    freePercent,
    // A file rounding to 0 stays in the list: it is present in the context,
    // and the UI renders 0 as `<1%` rather than dropping the row.
    memoryFiles: res.memoryFiles.map((f, i) => ({ path: f.path, percent: filePercents[i] })),
  };
}

const WINDOW_LABELS: { key: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'; id: string; label: string }[] = [
  { key: 'five_hour', id: 'five-hour', label: 'Session (5h)' },
  { key: 'seven_day', id: 'seven-day', label: 'Week' },
  { key: 'seven_day_opus', id: 'seven-day-opus', label: 'Week (Opus)' },
  { key: 'seven_day_sonnet', id: 'seven-day-sonnet', label: 'Week (Sonnet)' },
];

/**
 * The subset of `SDKRateLimitInfo` (sdk.d.ts:4421) this mapper reads,
 * declared structurally for the same reason `ContextUsageLike` is. Note
 * `resetsAt` is epoch ms here — the experimental usage response this module
 * used to read carried an ISO string instead, which is why nothing parses.
 */
export interface RateLimitInfoLike {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
}

/**
 * One `rate_limit_event` describes one window. An event we cannot label
 * (`overage`, `seven_day_overage_included`, or a type a future SDK adds) or
 * cannot quantify (no `utilization`) produces nothing: a chip with a guessed
 * label or an invented percentage is worse than a chip that is not there.
 */
export function toUsageWindow(info: RateLimitInfoLike | undefined): UsageWindow | undefined {
  if (!info) { return undefined; }
  const row = WINDOW_LABELS.find((w) => w.key === info.rateLimitType);
  if (!row) { return undefined; }
  if (typeof info.utilization !== 'number' || !Number.isFinite(info.utilization)) { return undefined; }
  const at = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
    ? info.resetsAt
    : undefined;
  return {
    id: row.id,
    label: row.label,
    usedPercent: Math.max(0, Math.min(100, Math.round(info.utilization))),
    ...(at !== undefined ? { resetsAt: at } : {}),
  };
}

/**
 * The subset of `SDKControlGetUsageResponse` (sdk.d.ts:3351) this mapper
 * reads, declared structurally for the same reason `ContextUsageLike` is.
 *
 * Two traps, both proven live and both the reason this is a separate mapper
 * from `toUsageWindow`:
 *   - `resets_at` is an ISO 8601 string here. The `rate_limit_event` push
 *     carries epoch SECONDS under the same name. Neither is epoch ms.
 *   - `utilization` is already 0-100 here. The push's is a 0-1 fraction.
 *     Scaling this one would render 6200% for a 62% window.
 */
export interface UsageResponseLike {
  rate_limits_available?: boolean;
  rate_limits?: Partial<Record<
    'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet',
    { utilization?: number | null; resets_at?: string | null } | null
  >> | null;
}

/**
 * The structured usage response as an ordered window list.
 *
 * `undefined` is a positive answer — the account has no plan limits at all
 * (API key, Bedrock, Vertex, or a missing profile scope) — and callers clear
 * persisted state on it. `[]` means limits apply but nothing is known yet,
 * and clears nothing. A window the response cannot quantify is dropped
 * rather than rendered at a guessed percentage.
 */
export function toUsageWindows(res: UsageResponseLike | undefined): UsageWindow[] | undefined {
  if (!res || res.rate_limits_available !== true) { return undefined; }
  const limits = res.rate_limits;
  if (!limits) { return []; }

  const out: UsageWindow[] = [];
  // Driven by WINDOW_LABELS rather than by the response's own keys, so a key
  // this table has never heard of (seven_day_oauth_apps, and whatever a
  // future SDK adds) is ignored instead of rendered with a guessed label.
  for (const row of WINDOW_LABELS) {
    const window = limits[row.key];
    if (!window) { continue; }
    const { utilization } = window;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) { continue; }
    const parsed = window.resets_at ? Date.parse(window.resets_at) : NaN;
    out.push({
      id: row.id,
      label: row.label,
      usedPercent: Math.max(0, Math.min(100, Math.round(utilization))),
      ...(Number.isFinite(parsed) ? { resetsAt: parsed } : {}),
    });
  }
  return out;
}

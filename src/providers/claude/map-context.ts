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

interface RateWindowLike {
  utilization: number | null;
  resets_at: string | null;
}

export interface UsageLike {
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: RateWindowLike | null;
    seven_day?: RateWindowLike | null;
    seven_day_opus?: RateWindowLike | null;
    seven_day_sonnet?: RateWindowLike | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
  } | null;
}

function share(tokens: number, max: number): number {
  return Math.round((tokens / max) * 100);
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
 * and needs no clamp. Ties break by array order (`parts` is always passed
 * as `[system, memory, conversation]`), so the output is deterministic.
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

  if (!Number.isFinite(max) || max <= 0 || base <= 0) {
    return {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 0, freePercent: 100,
      memoryFiles: [],
    };
  }

  const usedPercent = Math.max(0, Math.min(100, Math.round((Math.min(base, max) / max) * 100)));
  const freePercent = 100 - usedPercent;
  const [systemPercent, memoryPercent, conversationPercent] = largestRemainder(
    [systemTokens, memoryTokens, conversationTokens], base, usedPercent,
  );

  return {
    systemPercent,
    memoryPercent,
    conversationPercent,
    freePercent,
    // A file rounding to 0 stays in the list: it is present in the context,
    // and the UI renders 0 as `<1%` rather than dropping the row.
    memoryFiles: res.memoryFiles.map((f) => ({ path: f.path, percent: share(f.tokens, max) })),
  };
}

const WINDOW_LABELS: { key: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'; id: string; label: string }[] = [
  { key: 'five_hour', id: 'five-hour', label: 'Session (5h)' },
  { key: 'seven_day', id: 'seven-day', label: 'Week' },
  { key: 'seven_day_opus', id: 'seven-day-opus', label: 'Week (Opus)' },
  { key: 'seven_day_sonnet', id: 'seven-day-sonnet', label: 'Week (Sonnet)' },
];

function resetsAt(iso: string | null): number | undefined {
  if (!iso) { return undefined; }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function makeWindow(id: string, label: string, w: RateWindowLike): UsageWindow | undefined {
  if (w.utilization === null || !Number.isFinite(w.utilization)) { return undefined; }
  const at = resetsAt(w.resets_at);
  return {
    id, label,
    usedPercent: Math.max(0, Math.min(100, Math.round(w.utilization))),
    ...(at !== undefined ? { resetsAt: at } : {}),
  };
}

/**
 * `rate_limits_available` is false for API-key, Bedrock and Vertex sessions,
 * where plan limits simply do not exist. That is an empty list, not an
 * error — the strip renders "No plan limits" for it, which is a different
 * sentence from a failure.
 *
 * The output order is fixed (session, week, per-model), never sorted by
 * utilization: a strip that reorders itself between refreshes cannot be
 * read at a glance.
 */
export function toUsageWindows(res: UsageLike): UsageWindow[] {
  if (!res.rate_limits_available || !res.rate_limits) { return []; }
  const limits = res.rate_limits;
  const out: UsageWindow[] = [];

  for (const { key, id, label } of WINDOW_LABELS) {
    const w = limits[key];
    if (!w) { continue; }
    const mapped = makeWindow(id, label, w);
    if (mapped) { out.push(mapped); }
  }

  for (const scoped of limits.model_scoped ?? []) {
    const mapped = makeWindow(
      `model:${scoped.display_name}`,
      `Week (${scoped.display_name})`,
      scoped,
    );
    if (mapped) { out.push(mapped); }
  }

  return out;
}

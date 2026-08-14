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
 * Tokens enter here and percentages leave: this is the only place in the
 * codebase allowed to reason in tokens for these surfaces. `freePercent` is
 * derived by subtraction rather than from `maxTokens - totalTokens` so the
 * four slices always sum to exactly 100 despite per-slice rounding.
 */
export function toContextBreakdown(res: ContextUsageLike): ContextBreakdown {
  const max = res.maxTokens;
  if (!Number.isFinite(max) || max <= 0) {
    return {
      systemPercent: 0, memoryPercent: 0, conversationPercent: 0, freePercent: 100,
      memoryFiles: [],
    };
  }

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

  const systemPercent = share(systemTokens, max);
  const memoryPercent = share(memoryTokens, max);
  const conversationPercent = share(conversationTokens, max);
  const freePercent = Math.max(0, 100 - systemPercent - memoryPercent - conversationPercent);

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

import { clampPercent, DANGER_PERCENT } from '../../client-core/context-format';

export const PICKER_HINT = '^P model · ^E effort · ⇧Tab mode · ^T context';
// Pane chords work on any session, so unlike PICKER_HINT it is not gated on ownership.
export const LAYOUT_HINT = '^W g layout';

export interface StatusLayout { text: string; ctx?: { start: number; end: number; danger: boolean } }

interface StatusInput {
  provider: string; model?: string; effort?: string; permissionMode?: string;
  contextPercent?: number; owned: boolean; width: number;
}

export function statusLayout(o: StatusInput): StatusLayout {
  const head = [o.provider, o.model, o.effort, o.permissionMode].filter((p): p is string => Boolean(p)).join(' · ');
  const shown = o.contextPercent === undefined ? undefined : clampPercent(o.contextPercent);
  const ctx = shown === undefined ? undefined : `ctx ${shown}%`;
  const withCtx = ctx ? `${head} · ${ctx}` : head;
  const candidates: { text: string; hasCtx: boolean }[] = [];
  if (o.owned) {
    candidates.push({ text: `${withCtx}   ${PICKER_HINT} · ${LAYOUT_HINT}`, hasCtx: ctx !== undefined });
    candidates.push({ text: `${withCtx}   ${PICKER_HINT}`, hasCtx: ctx !== undefined });
  }
  candidates.push({ text: `${withCtx}   ${LAYOUT_HINT}`, hasCtx: ctx !== undefined });
  if (ctx) { candidates.push({ text: withCtx, hasCtx: true }); }
  candidates.push({ text: head, hasCtx: false });
  const fit = candidates.find((c) => c.text.length <= o.width);
  if (!fit) {
    return { text: `${head.slice(0, Math.max(0, o.width - 1))}…` };
  }
  if (!fit.hasCtx || !ctx || shown === undefined) { return { text: fit.text }; }
  const start = head.length + 3;
  return { text: fit.text, ctx: { start, end: start + ctx.length, danger: shown >= DANGER_PERCENT } };
}

export function hitsContext(layout: StatusLayout, x: number): boolean {
  return layout.ctx !== undefined && x >= layout.ctx.start && x < layout.ctx.end;
}

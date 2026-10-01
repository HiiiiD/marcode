import { maximizeSizes, type LayoutNode } from './layout-tree';

export interface Rect { x: number; y: number; w: number; h: number }
export interface PaneRect extends Rect { sessionId: string | null; path: number[] }
export interface DividerRect extends Rect {
  path: number[]; index: number; axis: 'x' | 'y'; pairStart: number; pairLength: number;
}

export const MIN_PANE_W = 40;
export const MIN_PANE_H = 8;

function shares(sizes: number[], total: number): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  const out = sizes.map((s) => Math.max(1, Math.floor((s / sum) * total)));
  out[out.length - 1] = Math.max(1, total - out.slice(0, -1).reduce((a, b) => a + b, 0));
  return out;
}

export function layoutRects(root: LayoutNode, area: Rect): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  const walk = (node: LayoutNode, r: Rect, path: number[]) => {
    if (node.kind === 'leaf') { panes.push({ ...r, sessionId: node.sessionId, path }); return; }
    const side = node.orientation === 'horizontal';
    const n = node.children.length;
    const total = Math.max(n, (side ? r.w : r.h) - (n - 1));
    const lens = shares(node.children.map((c) => c.size), total);
    let at = side ? r.x : r.y;
    node.children.forEach((child, i) => {
      const len = lens[i];
      walk(child, side ? { x: at, y: r.y, w: len, h: r.h } : { x: r.x, y: at, w: r.w, h: len }, [...path, i]);
      at += len;
      if (i < n - 1) {
        dividers.push({
          path, index: i, axis: side ? 'x' : 'y', pairStart: at - len, pairLength: len + lens[i + 1],
          ...(side ? { x: at, y: r.y, w: 1, h: r.h } : { x: r.x, y: at, w: r.w, h: 1 }),
        });
        at += 1;
      }
    });
  };
  walk(root, area, []);
  return { panes, dividers };
}

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function hitPane(panes: PaneRect[], x: number, y: number): PaneRect | undefined {
  return panes.find((p) => inside(p, x, y));
}

export function hitDivider(dividers: DividerRect[], x: number, y: number): DividerRect | undefined {
  return dividers.find((d) => inside(d, x, y));
}

export function neighbour(
  panes: PaneRect[], from: string, dir: 'left' | 'right' | 'up' | 'down',
): string | undefined {
  const f = panes.find((p) => p.sessionId === from);
  if (!f) { return undefined; }
  const horizontal = dir === 'left' || dir === 'right';
  const overlaps = (p: PaneRect) => (horizontal
    ? p.y < f.y + f.h && f.y < p.y + p.h
    : p.x < f.x + f.w && f.x < p.x + p.w);
  const gap = (p: PaneRect) => (dir === 'right' ? p.x - (f.x + f.w) : dir === 'left' ? f.x - (p.x + p.w)
    : dir === 'down' ? p.y - (f.y + f.h) : f.y - (p.y + p.h));
  const off = (p: PaneRect) => (horizontal ? p.y : p.x);
  return panes
    .filter((p) => p.sessionId !== null && p.sessionId !== from && gap(p) >= 0 && overlaps(p))
    .sort((a, b) => gap(a) - gap(b) || off(a) - off(b))[0]?.sessionId ?? undefined;
}

export function tooSmall(panes: PaneRect[]): boolean {
  return panes.some((p) => p.sessionId !== null && (p.w < MIN_PANE_W || p.h < MIN_PANE_H));
}

export function squeezedIds(panes: PaneRect[]): Set<string> {
  return new Set(panes.flatMap((p) => (p.sessionId !== null && (p.w < MIN_PANE_W || p.h < MIN_PANE_H) ? [p.sessionId] : [])));
}

/** The real tree's rects, or the focused-pane-maximised copy's when the real one does not fit (or `force`). View-only. */
export function visibleRects(
  root: LayoutNode, focusedId: string | null, area: Rect, force = false,
): ReturnType<typeof layoutRects> {
  const real = layoutRects(root, area);
  if (focusedId === null || (!force && !tooSmall(real.panes))) { return real; }
  return layoutRects(maximizeSizes(root, focusedId), area);
}

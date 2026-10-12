import {
  flattenLeaves, gridDims, gridLayout, leafSessionIds, placeSession, type LayoutNode,
} from './layout-tree';

export interface Size { width: number; height: number }

/** `viewport` and `minPane` share one unit: pixels in the webview, cells in the terminal. */
export interface AutoGridOptions {
  enabled: boolean;
  viewport: Size;
  minPane: Size;
}

export interface AutoPlacement {
  root: LayoutNode;
  /** The layout is hand-made and full, so a regrid is worth offering instead of imposing. */
  offerRearrange: boolean;
}

const TARGET_ASPECT = 4 / 3;
const WASTE_WEIGHT = 0.35;
// Below the minimum pane, a grid is still better than none; the shortfall just ranks it behind any that fits.
const UNDERSIZE_WEIGHT = 10;

function score(rows: number, cols: number, n: number, viewport: Size, minPane: Size): number {
  const w = viewport.width / cols;
  const h = viewport.height / rows;
  const shortfall = Math.max(0, 1 - w / minPane.width) + Math.max(0, 1 - h / minPane.height);
  return Math.abs(Math.log(w / h / TARGET_ASPECT)) + (rows * cols - n) * WASTE_WEIGHT + shortfall * UNDERSIZE_WEIGHT;
}

export function bestGrid(n: number, viewport: Size, minPane: Size): { rows: number; cols: number } {
  const count = Math.max(1, n);
  let best = { rows: count, cols: 1 };
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const s = score(rows, cols, count, viewport, minPane);
    if (s < bestScore) { best = { rows, cols }; bestScore = s; }
  }
  return best;
}

export function rearrange(root: LayoutNode, viewport: Size, minPane: Size): LayoutNode {
  const ids = leafSessionIds(root);
  const { rows, cols } = bestGrid(ids.length, viewport, minPane);
  return gridLayout(rows, cols, ids).root;
}

export function placeSessionAuto(
  root: LayoutNode, sessionId: string, focusedId: string | null | undefined,
  fallback: 'vertical' | 'horizontal', opts: AutoGridOptions,
): AutoPlacement {
  const plain = (): AutoPlacement => ({ root: placeSession(root, sessionId, focusedId, fallback), offerRearrange: false });
  const leaves = flattenLeaves(root);
  const alreadyPlaced = leaves.some((l) => l.sessionId === sessionId);
  if (!opts.enabled || alreadyPlaced || leaves.some((l) => l.sessionId === null)) { return plain(); }
  if (gridDims(root) === undefined) {
    return { root: placeSession(root, sessionId, focusedId, fallback), offerRearrange: true };
  }
  const ids = [...leafSessionIds(root), sessionId];
  const { rows, cols } = bestGrid(ids.length, opts.viewport, opts.minPane);
  return { root: gridLayout(rows, cols, ids).root, offerRearrange: false };
}

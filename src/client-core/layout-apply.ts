import type { LayoutNode } from '../protocol/messages';
import { fillShapeKeepingOverflow, gridLayout } from './layout-tree';

export const MAX_GRID_DIM = 6;

/** `hidden` is the open session ids no slot can hold; they stay in the roster. */
export interface LayoutPlan { root: LayoutNode; hidden: string[] }

export function clampDim(n: number): number {
  if (Number.isNaN(n)) { return 1; }
  return Math.min(MAX_GRID_DIM, Math.max(1, Math.round(n)));
}

export function planShape(shape: LayoutNode, openIds: string[]): LayoutPlan {
  return fillShapeKeepingOverflow(shape, openIds);
}

export function planGrid(rows: number, cols: number, openIds: string[]): LayoutPlan {
  return gridLayout(clampDim(rows), clampDim(cols), openIds);
}

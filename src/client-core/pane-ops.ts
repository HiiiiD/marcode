import { findPath, splitAt, type LayoutNode } from './layout-tree';

export function splitAtSession(
  root: LayoutNode, focusedId: string | null, orientation: 'vertical' | 'horizontal', newId: string,
): LayoutNode {
  const path = (focusedId ? findPath(root, focusedId) : undefined) ?? [];
  return splitAt(root, path, orientation, newId);
}

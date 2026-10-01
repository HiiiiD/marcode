import { at, findPath, replaceAt, type LayoutNode } from './layout-tree';
import type { DividerRect } from './pane-geometry';

export const MIN_SHARE = 8;

function withPair(root: LayoutNode, splitPath: number[], index: number, a: number): LayoutNode {
  const split = at(root, splitPath);
  if (split?.kind !== 'split' || !split.children[index] || !split.children[index + 1]) { return root; }
  const total = split.children[index].size + split.children[index + 1].size;
  const first = Math.min(total - MIN_SHARE, Math.max(MIN_SHARE, a));
  return replaceAt(root, splitPath, {
    ...split,
    children: split.children.map((c, i) => (i === index ? { ...c, size: first } : i === index + 1 ? { ...c, size: total - first } : c)),
  });
}

export function dragDivider(root: LayoutNode, d: DividerRect, pointer: number): LayoutNode {
  const split = at(root, d.path);
  if (split?.kind !== 'split' || !split.children[d.index] || !split.children[d.index + 1]) { return root; }
  const total = split.children[d.index].size + split.children[d.index + 1].size;
  const fraction = (pointer - d.pairStart) / Math.max(1, d.pairLength);
  return withPair(root, d.path, d.index, fraction * total);
}

export function nudgeDivider(root: LayoutNode, splitPath: number[], index: number, deltaPct: number): LayoutNode {
  const split = at(root, splitPath);
  if (split?.kind !== 'split' || !split.children[index]) { return root; }
  return withPair(root, splitPath, index, split.children[index].size + deltaPct);
}

export function evenAll(root: LayoutNode): LayoutNode {
  if (root.kind === 'leaf') { return root; }
  const each = 100 / root.children.length;
  return { ...root, children: root.children.map((c) => ({ ...evenAll(c), size: each })) };
}

export function nudgeFocused(
  root: LayoutNode, sessionId: string, dir: 'left' | 'right' | 'up' | 'down', pct: number,
): LayoutNode {
  const path = findPath(root, sessionId);
  if (path === undefined) { return root; }
  const wantOrientation = dir === 'left' || dir === 'right' ? 'horizontal' : 'vertical';
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const splitPath = path.slice(0, depth);
    const split = at(root, splitPath);
    if (split?.kind !== 'split' || split.orientation !== wantOrientation) { continue; }
    const grow = dir === 'right' || dir === 'down';
    const boundary = grow ? path[depth] : path[depth] - 1;
    if (boundary < 0 || boundary >= split.children.length - 1) { continue; }
    return nudgeDivider(root, splitPath, boundary, grow ? pct : -pct);
  }
  return root;
}

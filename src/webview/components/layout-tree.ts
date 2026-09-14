// Pure LayoutNode tree logic, kept dependency-free (no React, no `@/...`
// imports) so it can be required directly in the Node/mocha unit-test
// harness — same constraint and convention as pane-layout.ts. Shapes mirror
// `LayoutNode` from `protocol/messages.ts` structurally rather than
// importing it.

export type LayoutNode =
  | { kind: 'leaf'; sessionId: string | null; size: number }
  | { kind: 'split'; orientation: 'vertical' | 'horizontal'; children: LayoutNode[]; size: number };

export function emptyRoot(): LayoutNode {
  return { kind: 'leaf', sessionId: null, size: 100 };
}

export interface FlatLeaf {
  sessionId: string | null;
  path: number[];
  size: number;
}

/** Depth-first walk of every leaf, empty or not, each tagged with the child-index path to reach it. */
export function flattenLeaves(node: LayoutNode, path: number[] = []): FlatLeaf[] {
  if (node.kind === 'leaf') { return [{ sessionId: node.sessionId, path, size: node.size }]; }
  return node.children.flatMap((child, i) => flattenLeaves(child, [...path, i]));
}

export function leafSessionIds(node: LayoutNode): string[] {
  return flattenLeaves(node)
    .map((l) => l.sessionId)
    .filter((id): id is string => id !== null);
}

export function findPath(node: LayoutNode, sessionId: string): number[] | undefined {
  return flattenLeaves(node).find((l) => l.sessionId === sessionId)?.path;
}

export function slotCount(node: LayoutNode): number {
  return flattenLeaves(node).length;
}

export function at(node: LayoutNode, path: number[]): LayoutNode {
  let cur = node;
  for (const i of path) {
    if (cur.kind !== 'split') { throw new Error('layout-tree: path runs through a leaf'); }
    cur = cur.children[i];
  }
  return cur;
}

/** Immutable replace of the node at `path`, keeping every sibling's `size` untouched. */
export function replaceAt(node: LayoutNode, path: number[], next: LayoutNode): LayoutNode {
  if (path.length === 0) { return next; }
  if (node.kind !== 'split') { throw new Error('layout-tree: path runs through a leaf'); }
  const [head, ...rest] = path;
  return {
    ...node,
    children: node.children.map((child, i) => (i === head ? replaceAt(child, rest, next) : child)),
  };
}

function evenSizes(count: number): number[] {
  return count > 0 ? Array(count).fill(100 / count) : [];
}

/** Splits the leaf at `path` into a 2-child split of [existing leaf, new leaf(newSessionId)], 50/50. */
export function splitAt(
  root: LayoutNode, path: number[], orientation: 'vertical' | 'horizontal', newSessionId: string,
): LayoutNode {
  const target = at(root, path);
  if (target.kind !== 'split' && target.kind !== 'leaf') { throw new Error('unreachable'); }
  const size = target.size;
  const next: LayoutNode = {
    kind: 'split', orientation, size,
    children: [{ ...target, size: 50 }, { kind: 'leaf', sessionId: newSessionId, size: 50 }],
  };
  return replaceAt(root, path, next);
}

/** Sets the sessionId of the (empty) leaf at `path`. Throws if that leaf already holds a session — callers check via `flattenLeaves` first. */
export function assignAt(root: LayoutNode, path: number[], sessionId: string): LayoutNode {
  const target = at(root, path);
  if (target.kind !== 'leaf') { throw new Error('layout-tree: assignAt target is not a leaf'); }
  if (target.sessionId !== null) { throw new Error('layout-tree: assignAt target is not empty'); }
  return replaceAt(root, path, { ...target, sessionId });
}

/**
 * Removes a session from the tree. At the tree root, the leaf just goes
 * empty (there's nothing to collapse into). Nested under a split with only
 * one other sibling, the split collapses and the survivor takes the split's
 * own slot and size — the same "no split node has fewer than 2 children"
 * invariant the design doc's drag-to-split section describes, reused here
 * for the Hide button and roster-uncheck, both of which are really the same
 * "this session no longer has a pane" operation drag-move already needs.
 * With three or more siblings, the split survives and its remaining
 * children reflow evenly — matches the flat model's old
 * `evenlySizedPanes(remaining, orientation)`, which never preserved a
 * departing sibling's proportions either.
 */
export function removeSession(root: LayoutNode, sessionId: string): LayoutNode {
  const path = findPath(root, sessionId);
  if (path === undefined) { return root; }
  if (path.length === 0) { return { kind: 'leaf', sessionId: null, size: root.size }; }

  const parentPath = path.slice(0, -1);
  const childIndex = path[path.length - 1];
  const parent = at(root, parentPath);
  if (parent.kind !== 'split') { throw new Error('unreachable'); }

  const remaining = parent.children.filter((_, i) => i !== childIndex);
  if (remaining.length === 1) {
    return replaceAt(root, parentPath, { ...remaining[0], size: parent.size });
  }
  const sizes = evenSizes(remaining.length);
  return replaceAt(root, parentPath, {
    ...parent,
    children: remaining.map((child, i) => ({ ...child, size: sizes[i] })),
  });
}

/** In-place leaf sessionId swap — used by replace-session. No structural change, no reflow. */
export function replaceLeafSession(root: LayoutNode, oldSessionId: string, newSessionId: string): LayoutNode {
  const path = findPath(root, oldSessionId);
  if (path === undefined) { return root; }
  const target = at(root, path);
  if (target.kind !== 'leaf') { throw new Error('unreachable'); }
  return replaceAt(root, path, { ...target, sessionId: newSessionId });
}

/**
 * Fills a shape's leaves depth-first with `sessionIds`, in order. Extra
 * slots stay empty. Returns `undefined` — never a partial tree — when there
 * are more sessions than slots, so a caller can check-before-mutate and
 * never posts a half-applied preset.
 */
export function fillShape(shape: LayoutNode, sessionIds: string[]): LayoutNode | undefined {
  if (sessionIds.length > slotCount(shape)) { return undefined; }
  let i = 0;
  const fill = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') {
      return i < sessionIds.length ? { ...node, sessionId: sessionIds[i++] } : node;
    }
    return { ...node, children: node.children.map(fill) };
  };
  return fill(shape);
}

/** Same shape, every leaf's sessionId cleared — used when saving the current layout as a named preset. */
export function stripSessionIds(node: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') { return { ...node, sessionId: null }; }
  return { ...node, children: node.children.map(stripSessionIds) };
}

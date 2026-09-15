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

/**
 * Walks `path` down from `node`, returning `undefined` rather than throwing
 * when it runs through a leaf or names an out-of-range child index. A path
 * captured at render time (see `pane-group.tsx`'s three render-time call
 * sites) can go stale between a render and the click that uses it — a
 * `layout-changed` echo, another client's edit, or a concurrent replace can
 * all reshape the tree first — and "errors are state, never exceptions" means
 * a stale path is a no-op for the caller to detect, not a thrown exception
 * that unmounts the pane subtree from inside a React event handler.
 */
export function at(node: LayoutNode, path: number[]): LayoutNode | undefined {
  let cur: LayoutNode | undefined = node;
  for (const i of path) {
    if (cur === undefined || cur.kind !== 'split') { return undefined; }
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

/**
 * Splits the leaf at `path` into a 2-child split of the existing leaf and a
 * new leaf(newSessionId), 50/50. `insertBefore` puts the new leaf first —
 * the drag-to-split UI passes this for a left/top edge drop, so the dragged
 * pane lands on the side it was dropped on, matching VS Code's own
 * editor-group convention. Defaults to appending (existing, new), the
 * original behavior, so every pre-drag-and-drop caller is unaffected.
 */
export function splitAt(
  root: LayoutNode, path: number[], orientation: 'vertical' | 'horizontal', newSessionId: string,
  insertBefore = false,
): LayoutNode {
  const target = at(root, path);
  // `path` here is always freshly recomputed against `root` in the same
  // synchronous call (see `freshTargetPath`), never a stale render-time path
  // — so a miss here is a real invariant violation, not the stale-path case
  // `at`'s own undefined return exists to let a caller shrug off.
  if (target === undefined) { throw new Error('layout-tree: path runs through a leaf'); }
  const size = target.size;
  const existing = { ...target, size: 50 };
  const inserted: LayoutNode = { kind: 'leaf', sessionId: newSessionId, size: 50 };
  const next: LayoutNode = {
    kind: 'split', orientation, size,
    children: insertBefore ? [inserted, existing] : [existing, inserted],
  };
  return replaceAt(root, path, next);
}

/**
 * Sets the sessionId of the (empty) leaf at `path`. Returns `undefined`,
 * never throws, when `path` doesn't resolve or its target isn't an empty
 * leaf — the same stale-render-time-path contract `at` keeps, since this is
 * reached directly from `pane-group.tsx`'s drag/assign handlers with a path
 * captured at render time.
 */
export function assignAt(root: LayoutNode, path: number[], sessionId: string): LayoutNode | undefined {
  const target = at(root, path);
  if (target === undefined || target.kind !== 'leaf' || target.sessionId !== null) { return undefined; }
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
  // `parentPath` is a prefix of `path`, which `findPath` just located in this
  // same `root` — always resolvable, unlike a stale render-time path.
  if (parent === undefined || parent.kind !== 'split') { throw new Error('unreachable'); }

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
  // `path` came straight from `findPath` on this same `root`, so it always
  // resolves — same reasoning as `removeSession`'s `parent` lookup above.
  if (target === undefined || target.kind !== 'leaf') { throw new Error('unreachable'); }
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

function samePath(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The drop target's path, recomputed against the tree with the dragged
 * session's own old leaf already removed. `removeSession` can shift or
 * collapse indices anywhere along its former ancestor chain, so the
 * pre-removal `path` can no longer be trusted for the target — including an
 * *empty* target leaf, which (unlike a session's own leaf) carries no id
 * `findPath` could re-locate it by. `flattenLeaves` visits every leaf, empty
 * or not, in one fixed depth-first order that removing a single leaf never
 * reorders — it only shifts everything after it back by one — so the
 * target's position in that order, adjusted for whether the dragged leaf
 * came before it, is a stable way to re-find the same leaf after the
 * removal, whether or not it has a session id of its own.
 */
export function freshTargetPath(
  root: LayoutNode, targetPath: number[], draggedSessionId: string, withoutDragged: LayoutNode,
): number[] | undefined {
  const before = flattenLeaves(root);
  const draggedIndex = before.findIndex((l) => l.sessionId === draggedSessionId);
  const targetIndex = before.findIndex((l) => samePath(l.path, targetPath));
  if (draggedIndex === -1 || targetIndex === -1) { return undefined; }
  const adjusted = targetIndex > draggedIndex ? targetIndex - 1 : targetIndex;
  return flattenLeaves(withoutDragged)[adjusted]?.path;
}

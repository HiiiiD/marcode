import type { LayoutNode, LayoutPreset } from '../../protocol/messages';

const leaf = (): LayoutNode => ({ kind: 'leaf', sessionId: null, size: 50 });

export const BUILTIN_PRESETS: LayoutPreset[] = [
  {
    id: 'stack-2', name: '2 rows', builtin: true,
    root: { kind: 'split', orientation: 'vertical', size: 100, children: [leaf(), leaf()] },
  },
  {
    id: 'columns-2', name: '2 columns', builtin: true,
    root: { kind: 'split', orientation: 'horizontal', size: 100, children: [leaf(), leaf()] },
  },
  {
    id: 'columns-3', name: '3 columns', builtin: true,
    root: {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { ...leaf(), size: 100 / 3 },
        { ...leaf(), size: 100 / 3 },
        { ...leaf(), size: 100 / 3 },
      ],
    },
  },
  {
    id: 'grid-2x2', name: '2x2 grid', builtin: true,
    root: {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { kind: 'split', orientation: 'vertical', size: 50, children: [leaf(), leaf()] },
        { kind: 'split', orientation: 'vertical', size: 50, children: [leaf(), leaf()] },
      ],
    },
  },
  {
    id: 'asym-1-2', name: '1 large + 2 stacked', builtin: true,
    root: {
      kind: 'split', orientation: 'horizontal', size: 100,
      children: [
        { ...leaf(), size: 50 },
        { kind: 'split', orientation: 'vertical', size: 50, children: [leaf(), leaf()] },
      ],
    },
  },
];

/**
 * Structural equality ignoring `sessionId`/exact `size` — same kind/
 * orientation/child count at every level, recursively. Used to highlight the
 * currently-active preset, if any.
 */
export function shapeMatches(node: LayoutNode, shape: LayoutNode): boolean {
  if (node.kind !== shape.kind) { return false; }
  if (node.kind === 'leaf') { return true; }
  const shapeSplit = shape as Extract<LayoutNode, { kind: 'split' }>;
  if (node.orientation !== shapeSplit.orientation) { return false; }
  if (node.children.length !== shapeSplit.children.length) { return false; }
  return node.children.every((child, i) => shapeMatches(child, shapeSplit.children[i]));
}

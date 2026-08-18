import type { ElementContent } from 'hast';

/**
 * Plain-text content of a hast node, ignoring markup — used to build
 * clipboard/CSV payloads from parsed markdown without re-parsing rendered
 * React output. `react-markdown` hands every custom component the original
 * hast node via its `node` prop, so this works regardless of which
 * component the caller substitutes for the tag.
 */
export function hastText(node: ElementContent): string {
  if (node.type === 'text') { return node.value; }
  if (node.type === 'element') { return node.children.map(hastText).join(''); }
  return '';
}

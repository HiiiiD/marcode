import { cn } from '@/lib/utils';
import type { LayoutNode } from '../../protocol/messages';

/** A miniature of a layout tree: the shape is the whole label, so a picker can show it instead of describing it. */
export function LayoutThumb({ node, className }: { node: LayoutNode; className?: string }) {
  return (
    <div aria-hidden className={cn('flex h-7 w-11 gap-px', className)}>
      <ThumbNode node={node} />
    </div>
  );
}

function ThumbNode({ node }: { node: LayoutNode }) {
  if (node.kind === 'leaf') {
    return <div className="min-h-0 min-w-0 flex-1 rounded-[2px] bg-current opacity-30" />;
  }
  return (
    <div
      className={cn('flex min-h-0 min-w-0 flex-1 gap-px', node.orientation === 'vertical' && 'flex-col')}
    >
      {node.children.map((child, i) => (
        <div key={i} className="flex min-h-0 min-w-0" style={{ flex: `${child.size} 1 0%` }}>
          <ThumbNode node={child} />
        </div>
      ))}
    </div>
  );
}

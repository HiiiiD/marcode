import { Button } from '@/components/ui/button';

interface Props {
  onRearrange(): void;
  onKeep(): void;
  /** Present only when the panel is too narrow for a second column. */
  onExpand?: () => void;
}

export function RearrangeNotice({ onRearrange, onKeep, onExpand }: Props) {
  return (
    <div role="status" className="mx-2 mt-2 flex items-center gap-2 rounded border-2 border-border bg-muted/40 p-2 text-xs">
      <span className="min-w-0 flex-1">Layout is custom. Rearrange into a grid?</span>
      <Button size="xs" onClick={onRearrange}>Rearrange</Button>
      {onExpand && <Button size="xs" variant="outline" onClick={onExpand}>Expand sidebar</Button>}
      <Button size="xs" variant="ghost" onClick={onKeep}>Keep layout</Button>
    </div>
  );
}

import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

interface LayoutOverflowDialogProps {
  titles: string[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function LayoutOverflowDialog({ titles, onCancel, onConfirm }: LayoutOverflowDialogProps) {
  return (
    <Dialog open={titles !== null} onOpenChange={(open) => { if (!open) { onCancel(); } }}>
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          <DialogTitle className="text-sm">Hide {titles?.length ?? 0} sessions?</DialogTitle>
          <DialogDescription>
            This layout has fewer slots than open sessions. They stay in the roster and can be shown again.
          </DialogDescription>
        </DialogHeader>
        <ul className="list-disc pl-4">
          {titles?.map((title, i) => <li key={i} className="truncate">{title}</li>)}
        </ul>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
          <Button size="sm" onClick={onConfirm}>Hide and apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

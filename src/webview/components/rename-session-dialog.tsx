import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useStore } from '../store';
import type { SessionSummary } from '../../protocol/messages';

/**
 * Renames a session. Names are unique per window (case-insensitive,
 * enforced host-side by `SessionManager.rename`) — the only client-side
 * validation here is non-empty, so an obviously bad submission never leaves
 * the dialog, but a collision is still reported by the host, since only it
 * knows the full live roster.
 */
export function RenameSessionDialog({
  session, open, onOpenChange,
}: { session: SessionSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { post } = useStore();
  const [value, setValue] = useState(session.name);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) { setValue(session.name); }
        onOpenChange(next);
      }}
    >
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          {/* pr-7 clears the close button in the popup's top-right corner. */}
          <div className="border-b border-border pr-7 pb-2">
            <DialogTitle className="text-sm">Rename session</DialogTitle>
          </div>
        </DialogHeader>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">New name</span>
          <Input
            aria-label="New name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </label>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={value.trim().length === 0}
            onClick={() => {
              post({ t: 'rename-session', id: session.id, name: value.trim() });
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

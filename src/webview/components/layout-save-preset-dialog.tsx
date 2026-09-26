import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function SavePresetDialog({
  open, onOpenChange, onSave,
}: { open: boolean; onOpenChange: (open: boolean) => void; onSave: (name: string) => void }) {
  const [name, setName] = useState('');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { onOpenChange(next); if (!next) { setName(''); } }}
    >
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          <div className="border-b border-border pr-7 pb-2">
            <DialogTitle className="text-sm">Save current layout</DialogTitle>
          </div>
        </DialogHeader>
        <Input
          aria-label="Preset name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            disabled={name.trim() === ''}
            onClick={() => {
              onSave(name.trim());
              onOpenChange(false);
              setName('');
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { LayoutGridIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { fillShape, leafSessionIds, slotCount } from './layout-tree';
import { BUILTIN_PRESETS, shapeMatches } from './layout-presets';
import { useStore } from '../store';
import type { LayoutNode, LayoutPreset } from '../../protocol/messages';

/**
 * Fills a chosen preset shape with the currently-visible sessions,
 * depth-first, and posts it as the new layout.
 */
export function LayoutPresetsMenu() {
  const { state, post } = useStore();
  const [saveOpen, setSaveOpen] = useState(false);
  const visibleIds = leafSessionIds(state.layout.root);

  const apply = (shape: LayoutNode) => {
    const filled = fillShape(shape, visibleIds);
    // Belt-and-suspenders: the menu item that reaches here is disabled
    // whenever there's no room, so this is never a silent no-op the user
    // could trigger by clicking.
    if (!filled) { return; }
    post({ t: 'set-layout', layout: { ...state.layout, root: filled } });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="icon-sm" aria-label="Layout presets" className="shrink-0" />}
      >
        <LayoutGridIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {BUILTIN_PRESETS.map((preset) => (
          <PresetRow key={preset.id} preset={preset} visibleCount={visibleIds.length} state={state} apply={apply} />
        ))}
        {state.layout.presets.length > 0 && <DropdownMenuSeparator />}
        {state.layout.presets.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            visibleCount={visibleIds.length}
            state={state}
            apply={apply}
            onDelete={() => post({ t: 'delete-preset', id: preset.id })}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setSaveOpen(true)}>
          Save current layout…
        </DropdownMenuItem>
      </DropdownMenuContent>
      <SavePresetDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        onSave={(name) => post({ t: 'save-preset', name })}
      />
    </DropdownMenu>
  );
}

function PresetRow({
  preset, visibleCount, state, apply, onDelete,
}: {
  preset: LayoutPreset;
  visibleCount: number;
  state: ReturnType<typeof useStore>['state'];
  apply: (shape: LayoutNode) => void;
  onDelete?: () => void;
}) {
  const disabled = visibleCount > slotCount(preset.root);
  const active = shapeMatches(state.layout.root, preset.root);
  return (
    <div className="flex items-center">
      <DropdownMenuItem disabled={disabled} onClick={() => apply(preset.root)} className="flex-1">
        {preset.name}
        {active && ' ✓'}
      </DropdownMenuItem>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete ${preset.name}`}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}

function SavePresetDialog({
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

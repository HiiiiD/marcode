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
  const needed = slotCount(preset.root);
  const disabled = visibleCount > needed;
  const active = shapeMatches(state.layout.root, preset.root);
  // Same remedy as the orientation toggle's own disabled reason
  // (session-picker.tsx): a `disabled` menu item carries
  // `disabled:pointer-events-none` and is unreachable by hover, so the "why"
  // has to be real, rendered text an `aria-describedby` points at rather
  // than a `title`. Computed per preset — different shapes need different
  // counts, so a shared static string would lie about at least one of them.
  const reasonId = `preset-reason-${preset.id}`;
  // `role="none"` on the wrapper, not a plain `<div>`: Base UI's roving-focus
  // menu only manages `menuitem`-role children, and a wrapping element with
  // no ARIA role of its own is invisible to that navigation while its two
  // real `DropdownMenuItem` children — apply and delete — both stay reachable
  // by arrow keys. A sibling `Button` here (the previous shape) was never a
  // valid menu-item child, so arrow-key navigation could reach apply but
  // never delete.
  return (
    <div role="none" className="flex items-center">
      <DropdownMenuItem
        disabled={disabled}
        onClick={() => apply(preset.root)}
        className="flex-1"
        aria-describedby={disabled ? reasonId : undefined}
      >
        {preset.name}
        {active && ' ✓'}
      </DropdownMenuItem>
      {disabled && (
        <span id={reasonId} className="sr-only">
          {`Needs ${needed} panes; ${visibleCount} are open`}
        </span>
      )}
      {onDelete && (
        <DropdownMenuItem
          variant="destructive"
          aria-label={`Delete ${preset.name}`}
          className="w-auto shrink-0 justify-center px-1.5"
          // Still required even as a sibling item, not a nested control: Base
          // UI's menu can treat a click as selecting whichever item it
          // bubbles through first if this doesn't stop it reaching apply's.
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
        >
          <XIcon aria-hidden />
        </DropdownMenuItem>
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

import { useState, type ReactNode } from 'react';
import { CheckIcon, LayoutGridIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { fillShapeKeepingOverflow, gridDims, gridLayout, leafSessionIds } from './layout-tree';
import { rearrange } from '../../client-core/auto-grid';
import { MIN_PANE } from '../min-pane';
import { BUILTIN_PRESETS, shapeMatches } from '../../client-core/layout-presets';
import { LayoutOverflowDialog } from './layout-overflow-dialog';
import { LayoutSizePicker } from './layout-size-picker';
import { LayoutThumb } from './layout-thumb';
import { SavePresetDialog } from './layout-save-preset-dialog';
import { useStore } from '../store';
import type { LayoutNode, LayoutPreset } from '../../protocol/messages';

interface Pending { root: LayoutNode; titles: string[] }

export function LayoutMenu() {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const openIds = leafSessionIds(state.layout.root);

  const commit = (root: LayoutNode) => {
    post({ t: 'set-layout', layout: { ...state.layout, root } });
    setOpen(false);
  };
  const request = (next: { root: LayoutNode; hidden: string[] }) => {
    if (next.hidden.length === 0) { commit(next.root); return; }
    const titles = next.hidden.map((id) => state.sessions.find((s) => s.id === id)?.title ?? id);
    setPending({ root: next.root, titles });
  };
  const applyShape = (shape: LayoutNode) => request(fillShapeKeepingOverflow(shape, openIds));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="icon-sm" aria-label="Layout" className="shrink-0" />}>
        <LayoutGridIcon aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" initialFocus={false} className="flex w-80 flex-col gap-3 p-3 text-xs">
        <Section title="Layouts">
          <div className="grid grid-cols-3 gap-1.5">
            {BUILTIN_PRESETS.map((preset) => (
              <PresetTile
                key={preset.id}
                preset={preset}
                active={shapeMatches(state.layout.root, preset.root)}
                onApply={() => applyShape(preset.root)}
              />
            ))}
            {state.layout.presets.map((preset) => (
              <PresetTile
                key={preset.id}
                preset={preset}
                active={shapeMatches(state.layout.root, preset.root)}
                onApply={() => applyShape(preset.root)}
                onDelete={() => post({ t: 'delete-preset', id: preset.id })}
              />
            ))}
          </div>
        </Section>
        <Section title="Custom grid">
          <LayoutSizePicker
            current={gridDims(state.layout.root) ?? null}
            onPick={(rows, cols) => request(gridLayout(rows, cols, openIds))}
          />
        </Section>
        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={openIds.length < 2}
            onClick={() => commit(rearrange(state.layout.root, { width: window.innerWidth, height: window.innerHeight }, MIN_PANE))}
          >
            Auto arrange
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
            Save as preset…
          </Button>
        </div>
      </PopoverContent>
      <SavePresetDialog open={saveOpen} onOpenChange={setSaveOpen} onSave={(name) => post({ t: 'save-preset', name })} />
      <LayoutOverflowDialog
        titles={pending?.titles ?? null}
        onCancel={() => setPending(null)}
        onConfirm={() => { if (pending) { commit(pending.root); } setPending(null); }}
      />
    </Popover>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function PresetTile({
  preset, active, onApply, onDelete,
}: { preset: LayoutPreset; active: boolean; onApply: () => void; onDelete?: () => void }) {
  return (
    <div className="group/tile relative">
      <button
        type="button"
        aria-label={preset.name}
        aria-pressed={active}
        onClick={onApply}
        className={cn(
          'relative flex w-full flex-col items-center gap-1 rounded-md border px-1 pt-2 pb-1.5 text-muted-foreground outline-none transition-colors',
          'hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground/30',
          active ? 'border-primary bg-primary/10 text-foreground' : 'border-border',
        )}
      >
        {active && <CheckIcon aria-hidden className="absolute top-1 left-1 size-3 text-primary" />}
        <LayoutThumb node={preset.root} />
        <span className="line-clamp-2 w-full text-center text-[0.6875rem] leading-tight">{preset.name}</span>
      </button>
      {onDelete && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete ${preset.name}`}
          className="absolute top-0.5 right-0.5 size-5 opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100"
          onClick={onDelete}
        >
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}

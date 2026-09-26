import { useState } from 'react';
import { LayoutGridIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { fillShapeKeepingOverflow, gridLayout, leafSessionIds } from './layout-tree';
import { BUILTIN_PRESETS, shapeMatches } from './layout-presets';
import { LayoutGridPreview } from './layout-grid-preview';
import { LayoutOverflowDialog } from './layout-overflow-dialog';
import { SavePresetDialog } from './layout-save-preset-dialog';
import { useStore } from '../store';
import type { LayoutNode } from '../../protocol/messages';

const MAX_DIM = 6;
const single = (v: number | readonly number[]) => (typeof v === 'number' ? v : v[0]);

interface Pending { root: LayoutNode; titles: string[] }

export function LayoutMenu() {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [rows, setRows] = useState(1);
  const [cols, setCols] = useState(2);
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
      <PopoverContent side="bottom" align="start" className="flex w-64 flex-col gap-3 p-3 text-xs">
        <div className="flex flex-col gap-2">
          <DimSlider label="Rows" value={rows} onChange={setRows} />
          <DimSlider label="Columns" value={cols} onChange={setCols} />
          <LayoutGridPreview rows={rows} cols={cols} filled={openIds.length} />
          <Button size="sm" onClick={() => request(gridLayout(rows, cols, openIds))}>Apply</Button>
        </div>
        <Separator />
        <div className="flex flex-col gap-0.5">
          {BUILTIN_PRESETS.map((preset) => (
            <PresetRow
              key={preset.id}
              name={preset.name}
              active={shapeMatches(state.layout.root, preset.root)}
              onApply={() => applyShape(preset.root)}
            />
          ))}
          {state.layout.presets.map((preset) => (
            <PresetRow
              key={preset.id}
              name={preset.name}
              active={shapeMatches(state.layout.root, preset.root)}
              onApply={() => applyShape(preset.root)}
              onDelete={() => post({ t: 'delete-preset', id: preset.id })}
            />
          ))}
          <Button variant="ghost" size="sm" className="justify-start" onClick={() => setSaveOpen(true)}>
            Save current layout…
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

function DimSlider({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <Slider
        getThumbAriaLabel={() => label}
        min={1}
        max={MAX_DIM}
        step={1}
        value={[value]}
        onValueChange={(v) => onChange(single(v))}
      />
      <span className="w-3 shrink-0 text-right tabular-nums">{value}</span>
    </div>
  );
}

function PresetRow({
  name, active, onApply, onDelete,
}: { name: string; active: boolean; onApply: () => void; onDelete?: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={onApply}>
        {name}
        {active && ' ✓'}
      </Button>
      {onDelete && (
        <Button variant="ghost" size="icon-xs" aria-label={`Delete ${name}`} onClick={onDelete}>
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}

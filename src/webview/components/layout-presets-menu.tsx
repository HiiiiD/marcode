import { LayoutGridIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { fillShape, leafSessionIds, slotCount } from './layout-tree';
import { BUILTIN_PRESETS, shapeMatches } from './layout-presets';
import { useStore } from '../store';
import type { LayoutNode } from '../../protocol/messages';

/**
 * Fills a chosen preset shape with the currently-visible sessions,
 * depth-first, and posts it as the new layout. `window.prompt` stands in for
 * "Save current layout…"'s name entry until task 12 gives it a real dialog —
 * `save-preset`/`delete-preset` themselves are also task 12's to wire.
 */
export function LayoutPresetsMenu() {
  const { state, post } = useStore();
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
        {BUILTIN_PRESETS.map((preset) => {
          const disabled = visibleIds.length > slotCount(preset.root);
          const active = shapeMatches(state.layout.root, preset.root);
          return (
            <DropdownMenuItem key={preset.id} disabled={disabled} onClick={() => apply(preset.root)}>
              {preset.name}
              {active && ' ✓'}
            </DropdownMenuItem>
          );
        })}
        {state.layout.presets.length > 0 && <DropdownMenuSeparator />}
        {state.layout.presets.map((preset) => {
          const disabled = visibleIds.length > slotCount(preset.root);
          const active = shapeMatches(state.layout.root, preset.root);
          return (
            <DropdownMenuItem key={preset.id} disabled={disabled} onClick={() => apply(preset.root)}>
              {preset.name}
              {active && ' ✓'}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            const name = window.prompt('Name this layout:');
            if (!name) { return; }
            post({ t: 'save-preset', name });
          }}
        >
          Save current layout…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

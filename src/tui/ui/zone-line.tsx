import { TextAttributes } from '@opentui/core';
import type { Zone } from '../keymap';
import { zoneBar } from '../view/zone-hints';
import { useTheme } from './termcn/hooks/use-theme';
import { useTokens } from './tokens/tokens-provider';

export function ZoneLine({ zone, width, modal }: { zone: Zone; width: number; modal: boolean }) {
  const theme = useTheme();
  const muted = useTokens()?.textMuted ?? 'gray';
  const bar = modal ? { label: 'dialog', hints: 'Esc close' } : zoneBar(zone, width);
  return (
    <text fg={muted} wrapMode="none">
      <span fg={theme.colors.warning} attributes={TextAttributes.BOLD}>{`[${bar.label}]`}</span>
      {bar.hints ? ` ${bar.hints}` : ''}
    </text>
  );
}

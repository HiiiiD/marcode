import { TextAttributes } from '@opentui/core';
import type { Zone } from '../keymap';
import { zoneBar } from '../view/zone-hints';
import { useTheme } from './termcn/hooks/use-theme';
import { useTokens } from './tokens/tokens-provider';

export function ZoneLine({ zone, width, modal }: { zone: Zone; width: number; modal: boolean }) {
  const theme = useTheme();
  const tokens = useTokens();
  const bar = modal ? { label: 'dialog', hints: 'Esc close' } : zoneBar(zone, width - 3);
  return (
    <box flexShrink={0} height={1} backgroundColor={tokens?.menu} paddingLeft={1}>
      <text wrapMode="none" {...(tokens ? { fg: tokens.text } : {})}>
        <span bg={theme.colors.warning} fg="black" attributes={TextAttributes.BOLD}>{` ${bar.label.toUpperCase()} `}</span>
        {bar.hints ? `  ${bar.hints}` : ''}
      </text>
    </box>
  );
}

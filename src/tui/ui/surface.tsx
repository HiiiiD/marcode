import type { BorderCharacters } from '@opentui/core';
import type { ComponentProps } from 'react';
import type { TuiTokens } from './tokens/derive-tokens';
import { useTokens } from './tokens/tokens-provider';

// Half-block edges drawn in the fill colour over a transparent border cell read as rounded corners;
// a box's own fill would paint the border cells too, which is why the fill lives on an inner box.
export const ROUND_CHARS: BorderCharacters = {
  topLeft: '▗', topRight: '▖', bottomLeft: '▝', bottomRight: '▘', horizontal: '▄', vertical: '█',
  topT: '', bottomT: '', leftT: '', rightT: '', cross: '',
};

export type SurfaceTone = keyof Pick<TuiTokens, 'pane' | 'paneActive' | 'panel' | 'element' | 'menu'>;

type BoxProps = ComponentProps<'box'>;
export type SurfaceProps = Omit<BoxProps, 'border' | 'borderStyle' | 'borderColor' | 'customBorderChars' | 'backgroundColor'> & {
  tone?: SurfaceTone;
  /** Border colour when the terminal gave no palette to derive a surface from. */
  fallbackBorder?: string;
  /** Inner horizontal padding; lives inside the fill, so it cannot go on the border box. */
  padX?: number;
  /** A border label on the fallback frame; a muted first line inside the fill otherwise. */
  title?: string;
};

export function Surface({ tone = 'panel', fallbackBorder = 'gray', padX = 0, title, children, flexDirection, ...box }: SurfaceProps) {
  const tokens = useTokens();
  if (!tokens) {
    return <box border borderStyle="single" borderColor={fallbackBorder} flexDirection={flexDirection} {...(title ? { title } : {})} {...box}>{children}</box>;
  }
  const fill = tokens[tone];
  return (
    <box border customBorderChars={ROUND_CHARS} borderColor={fill} {...box}>
      <box flexGrow={1} flexShrink={1} minHeight={0} minWidth={0} flexDirection={flexDirection} paddingLeft={padX} paddingRight={padX} backgroundColor={fill}>
        {title ? <text fg={tokens.textMuted}>{title}</text> : null}
        {children}
      </box>
    </box>
  );
}

import type { BoxProps } from '@opentui/react';
import type { ReactNode } from 'react';
import type { TuiTokens } from './tokens/derive-tokens';
import { useTheme } from './termcn/hooks/use-theme';
import { useTokens } from './tokens/tokens-provider';

export type SurfaceTone = keyof Pick<TuiTokens, 'pane' | 'paneActive' | 'panel' | 'element' | 'menu'>;

export type SurfaceProps = Omit<BoxProps, 'border' | 'borderStyle' | 'borderColor' | 'customBorderChars' | 'backgroundColor'> & {
  tone?: SurfaceTone;
  /** Border colour when the terminal gave no palette to derive a surface from. */
  fallbackBorder?: string;
  padX?: number;
  padY?: number;
  /** Reserves a one-cell frame; it is only drawn while true, and otherwise blends into the fill so focus changes never shift the layout. */
  ring?: boolean;
  /** A border label on the fallback frame; a muted first line inside the fill otherwise. */
  title?: string;
  children?: ReactNode;
};

export function Surface({ tone = 'panel', fallbackBorder = 'gray', padX = 0, padY = 0, ring, title, children, ...box }: SurfaceProps) {
  const tokens = useTokens();
  const theme = useTheme();
  if (!tokens) {
    return <box border borderStyle="single" borderColor={fallbackBorder} {...(title ? { title } : {})} {...box}>{children}</box>;
  }
  return (
    <box
      backgroundColor={tokens[tone]}
      {...(ring === undefined ? {} : { border: true, borderStyle: 'single' as const, borderColor: ring ? theme.colors.primary : tokens[tone] })}
      paddingLeft={padX} paddingRight={padX} paddingTop={padY} paddingBottom={padY} {...box}>
      {title ? <text flexShrink={0} fg={tokens.textMuted}>{title}</text> : null}
      {children}
    </box>
  );
}

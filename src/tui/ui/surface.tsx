import type { ComponentProps } from 'react';
import type { TuiTokens } from './tokens/derive-tokens';
import { useTokens } from './tokens/tokens-provider';

export type SurfaceTone = keyof Pick<TuiTokens, 'pane' | 'paneActive' | 'panel' | 'element' | 'menu'>;

type BoxProps = ComponentProps<'box'>;
export type SurfaceProps = Omit<BoxProps, 'border' | 'borderStyle' | 'borderColor' | 'customBorderChars' | 'backgroundColor'> & {
  tone?: SurfaceTone;
  /** Border colour when the terminal gave no palette to derive a surface from. */
  fallbackBorder?: string;
  padX?: number;
  padY?: number;
  /** A border label on the fallback frame; a muted first line inside the fill otherwise. */
  title?: string;
};

export function Surface({ tone = 'panel', fallbackBorder = 'gray', padX = 0, padY = 0, title, children, ...box }: SurfaceProps) {
  const tokens = useTokens();
  if (!tokens) {
    return <box border borderStyle="single" borderColor={fallbackBorder} {...(title ? { title } : {})} {...box}>{children}</box>;
  }
  return (
    <box backgroundColor={tokens[tone]} paddingLeft={padX} paddingRight={padX} paddingTop={padY} paddingBottom={padY} {...box}>
      {title ? <text flexShrink={0} fg={tokens.textMuted}>{title}</text> : null}
      {children}
    </box>
  );
}

import type { SyntaxStyle } from '@opentui/core';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { TuiTokens } from './derive-tokens';
import { buildSyntaxStyle } from './syntax-style';

interface TokensValue { tokens: TuiTokens | undefined; syntaxStyle: SyntaxStyle | undefined }

const Ctx = createContext<TokensValue>({ tokens: undefined, syntaxStyle: undefined });
let fallback: SyntaxStyle | undefined;

export function TokensProvider(props: { tokens: TuiTokens | undefined; children: ReactNode }) {
  const value = useMemo(
    () => ({ tokens: props.tokens, syntaxStyle: buildSyntaxStyle(props.tokens) }),
    [props.tokens],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export const useTokens = (): TuiTokens | undefined => useContext(Ctx).tokens;

export function useSyntaxStyle(): SyntaxStyle {
  const { syntaxStyle } = useContext(Ctx);
  // Native handle is allocated lazily so importing this module costs nothing.
  return syntaxStyle ?? (fallback ??= buildSyntaxStyle(undefined));
}

import type { SyntaxStyle } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TuiTokens } from './derive-tokens';
import { buildSyntaxStyle } from './syntax-style';

interface TokensValue { tokens: TuiTokens | undefined; syntaxStyle: SyntaxStyle | undefined }

const Ctx = createContext<TokensValue>({ tokens: undefined, syntaxStyle: undefined });
// Native styles belong to one renderer's context, so the lazy fallback is cached per renderer.
const fallbacks = new WeakMap<object, SyntaxStyle>();

export function TokensProvider(props: { tokens: TuiTokens | undefined; children: ReactNode }) {
  const owner = useRenderer().nativeScene;
  const value = useMemo(
    () => ({ tokens: props.tokens, syntaxStyle: buildSyntaxStyle(props.tokens, owner) }),
    [props.tokens, owner],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export const useTokens = (): TuiTokens | undefined => useContext(Ctx).tokens;

export function useSyntaxStyle(): SyntaxStyle {
  const { syntaxStyle } = useContext(Ctx);
  const owner = useRenderer().nativeScene;
  if (syntaxStyle) { return syntaxStyle; }
  let style = fallbacks.get(owner);
  if (!style) { style = buildSyntaxStyle(undefined, owner); fallbacks.set(owner, style); }
  return style;
}

// First paint never waits on the terminal's palette reply; tokens switch in when (and if) it arrives.
export function DetectedTokensProvider(props: { detect: () => Promise<TuiTokens | undefined>; children: ReactNode }) {
  const [tokens, setTokens] = useState<TuiTokens | undefined>(undefined);
  const { detect } = props;
  useEffect(() => {
    let live = true;
    void detect().then((t) => { if (live) { setTokens(t); } });
    return () => { live = false; };
  }, [detect]);
  return <TokensProvider tokens={tokens}>{props.children}</TokensProvider>;
}

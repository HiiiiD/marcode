import { afterEach, expect, test } from 'bun:test';
import { detectTokens } from '../../tui/ui/tokens/detect-tokens';
import { deriveTokens, type TerminalColorsLike } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider, useSyntaxStyle, useTokens } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe() {
  const tokens = useTokens();
  const style = useSyntaxStyle();
  return <text>{`${tokens ? 'tokens' : 'none'}:${typeof style}`}</text>;
}

test('without a provider there are no tokens, but a syntax style still exists', async () => {
  m = await mount(<Probe />);
  expect(m.frame()).toContain('none:object');
});

test('a provider exposes its tokens', async () => {
  m = await mount(<TokensProvider tokens={deriveTokens(DARK)}><Probe /></TokensProvider>);
  expect(m.frame()).toContain('tokens:object');
});

test('detectTokens derives tokens from the renderer palette', async () => {
  const t = await detectTokens({ getPalette: async () => DARK });
  expect(t?.panel === deriveTokens(DARK)?.panel).toBe(true);
});

test('detectTokens is undefined when the palette has no usable colors', async () => {
  const t = await detectTokens({ getPalette: async () => ({ ...DARK, defaultBackground: null }) });
  expect(t === undefined).toBe(true);
});

test('detectTokens is undefined when getPalette rejects', async () => {
  const t = await detectTokens({ getPalette: async () => { throw new Error('unsupported'); } });
  expect(t === undefined).toBe(true);
});

test('detectTokens gives up when the terminal never answers', async () => {
  const t0 = Date.now();
  const t = await detectTokens({ getPalette: () => new Promise<TerminalColorsLike>(() => undefined) }, 30);
  expect(t === undefined).toBe(true);
  expect(Date.now() - t0 < 500).toBe(true);
});

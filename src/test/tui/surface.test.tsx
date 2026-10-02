import { afterEach, expect, test } from 'bun:test';
import { Surface } from '../../tui/ui/surface';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const tokens = deriveTokens(DARK);
const card = (withTokens: boolean) => (
  <TokensProvider tokens={withTokens ? tokens : undefined}>
    <Surface tone="panel" width={12} height={5} title="label"><text>BODY</text></Surface>
  </TokensProvider>
);
const bgOf = (needle: string) => m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))?.bg.toString() ?? '';

test('with tokens the corners are rounded and no line frame is drawn', async () => {
  m = await mount(card(true), { width: 20, height: 8 });
  const f = m.frame();
  expect(['▗', '▖', '▝', '▘'].every((c) => f.includes(c))).toBe(true);
  expect(['┌', '┐', '└', '┘', '│'].some((c) => f.includes(c))).toBe(false);
});

test('with tokens the label becomes a first line inside the fill', async () => {
  m = await mount(card(true), { width: 20, height: 8 });
  expect(m.frame()).toContain('label');
  expect(bgOf('BODY') === '').toBe(false);
});

test('without tokens the single-line frame stays', async () => {
  m = await mount(card(false), { width: 20, height: 8 });
  const f = m.frame();
  expect(['┌', '┐', '└', '┘'].every((c) => f.includes(c))).toBe(true);
  expect(['▗', '▖', '▝', '▘'].some((c) => f.includes(c))).toBe(false);
});

test('the border cells keep the terminal background while the interior takes the fill', async () => {
  m = await mount(card(true), { width: 20, height: 8 });
  const spans = m.setup.captureSpans().lines.flatMap((l) => l.spans);
  const edge = spans.find((s) => s.text.startsWith('▗'));
  expect(edge !== undefined && edge.bg.toString() === bgOf('BODY')).toBe(false);
});

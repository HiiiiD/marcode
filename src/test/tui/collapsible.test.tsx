import { afterEach, expect, test } from 'bun:test';
import { Collapsible } from '../../tui/ui/transcript/collapsible';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const tokens = deriveTokens(DARK);
const card = (open: boolean, withTokens = false) => {
  const c = (
    <Collapsible open={open} header={<text>HEADER</text>}>
      <text>BODY</text>
    </Collapsible>
  );
  return withTokens ? <TokensProvider tokens={tokens}>{c}</TokensProvider> : c;
};
const FRAME_GLYPHS = ['┌', '┐', '└', '┘', '│', '─', '┃'];

test('closed shows the header and hides the body', async () => {
  m = await mount(card(false));
  expect(m.frame()).toContain('HEADER');
  expect(m.frame().includes('BODY')).toBe(false);
});

test('a card is flat: no frame, bar or divider, with or without a palette', async () => {
  for (const withTokens of [false, true]) {
    m = await mount(card(true, withTokens));
    const f = m.frame();
    expect(f).toContain('BODY');
    expect(FRAME_GLYPHS.some((c) => f.includes(c))).toBe(false);
    m.destroy();
    m = undefined;
  }
});

test('a tokened card paints no fill of its own', async () => {
  m = await mount(card(true, true));
  const spans = m.setup.captureSpans().lines.flatMap((l) => l.spans);
  const bg = (needle: string) => spans.find((s) => s.text.includes(needle))?.bg.toString() ?? '';
  const blank = spans.find((s) => s.text.trim() === '')?.bg.toString() ?? '';
  expect(bg('HEADER') === blank).toBe(true);
  expect(bg('BODY') === blank).toBe(true);
});

test('the body hangs indented under the header', async () => {
  m = await mount(card(true));
  const rows = m.frame().split('\n');
  const col = (needle: string) => rows.find((r) => r.includes(needle))?.indexOf(needle) ?? -1;
  expect(col('BODY') > col('HEADER')).toBe(true);
});

test('width is capped at 100, or 180 when wide', async () => {
  const long = (wide: boolean) => <Collapsible open={false} wide={wide} header={<text>{'x'.repeat(200)}</text>} />;
  const widest = () => Math.max(...m!.frame().split('\n').map((r) => r.trimEnd().length));
  m = await mount(long(false), { width: 220, height: 10 });
  expect(widest() <= 100).toBe(true);
  m.destroy();
  m = await mount(long(true), { width: 220, height: 10 });
  const w = widest();
  expect(w > 100 && w <= 180).toBe(true);
});

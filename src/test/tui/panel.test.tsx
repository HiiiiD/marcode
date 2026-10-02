import { afterEach, expect, test } from 'bun:test';
import { Collapsible } from '../../tui/ui/transcript/collapsible';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const tokens = deriveTokens(DARK);
const card = (open: boolean, selected = false) => (
  <TokensProvider tokens={tokens}>
    <Collapsible open={open} selected={selected} header={<text>HEADER</text>}>
      <text>BODY</text>
    </Collapsible>
  </TokensProvider>
);
const spans = () => m!.setup.captureSpans().lines.flatMap((l) => l.spans);
const bgOf = (needle: string) => spans().find((s) => s.text.includes(needle))?.bg.toString() ?? '';

test('a tokened card has a left bar and no box frame', async () => {
  m = await mount(card(false));
  const f = m.frame();
  expect(f).toContain('HEADER');
  expect(f).toContain('┃');
  expect(['┌', '┐', '└', '┘'].some((c) => f.includes(c))).toBe(false);
});

test('the header span carries a painted background', async () => {
  m = await mount(card(false));
  expect(bgOf('HEADER') === '').toBe(false);
});

test('selecting swaps the tint to the menu surface', async () => {
  m = await mount(card(false, false));
  const idle = bgOf('HEADER');
  m.destroy();
  m = await mount(card(false, true));
  expect(bgOf('HEADER') === idle).toBe(false);
});

test('open shows the body; closed hides it', async () => {
  m = await mount(card(true));
  expect(m.frame()).toContain('BODY');
  m.destroy();
  m = await mount(card(false));
  expect(m.frame().includes('BODY')).toBe(false);
});

test('width is capped at 100, or 180 when wide', async () => {
  // A long unbroken header fills the card, so the widest row is the card width (the tint has no right border to measure).
  const long = (wide: boolean) => (
    <TokensProvider tokens={tokens}>
      <Collapsible open={false} selected={false} wide={wide} header={<text>{'x'.repeat(200)}</text>} />
    </TokensProvider>
  );
  const widest = () => Math.max(...m!.frame().split('\n').map((r) => r.trimEnd().length));
  m = await mount(long(false), { width: 220, height: 10 });
  expect(widest() <= 100).toBe(true);
  m.destroy();
  m = await mount(long(true), { width: 220, height: 10 });
  const w = widest();
  expect(w > 100 && w <= 180).toBe(true);
});

test('selecting changes the header strip but leaves the body surface alone, so a diff inside never mismatches', async () => {
  m = await mount(card(true, false));
  const idleBody = bgOf('BODY');
  m.destroy();
  m = await mount(card(true, true));
  expect(bgOf('BODY') === idleBody).toBe(true);
});

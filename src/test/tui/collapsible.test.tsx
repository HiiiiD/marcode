import { afterEach, expect, test } from 'bun:test';
import { Collapsible } from '../../tui/ui/transcript/collapsible';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const card = (open: boolean, selected = false) => (
  <Collapsible open={open} selected={selected} header={<text>HEADER</text>}>
    <text>BODY</text>
  </Collapsible>
);
const borderFg = () => {
  const span = m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes('┌'));
  return span === undefined ? '' : span.fg.toString();
};

test('closed shows the header and hides the body', async () => {
  m = await mount(card(false));
  expect(m.frame()).toContain('HEADER');
  expect(m.frame().includes('BODY')).toBe(false);
});

test('open shows the body under a divider inside the same border', async () => {
  m = await mount(card(true));
  expect(m.frame()).toContain('BODY');
  expect(m.frame().split('\n').filter((r) => r.includes('─')).length >= 3).toBe(true);
});

test('the border changes colour when selected', async () => {
  m = await mount(card(false, false));
  const idle = borderFg();
  m.destroy();
  m = await mount(card(false, true));
  expect(idle === '').toBe(false);
  expect(borderFg() === idle).toBe(false);
});

test('the card never grows past 100 columns on a wide terminal', async () => {
  m = await mount(card(false), { width: 200, height: 10 });
  const widest = Math.max(...m.frame().split('\n').map((r) => r.trimEnd().length));
  expect(widest <= 100).toBe(true);
});

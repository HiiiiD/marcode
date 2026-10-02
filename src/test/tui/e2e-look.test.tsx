import { afterEach, expect, test } from 'bun:test';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { DARK } from '../fixtures/terminal-colors';
import { mountBooted, until } from './e2e-harness';

type Mounted = Awaited<ReturnType<typeof mountBooted>>;
let m: Mounted | undefined;
afterEach(async () => { await m?.destroy(); m = undefined; });

test('with a derived palette the app is square tinted surfaces, with a gap between roster and pane', async () => {
  m = await mountBooted({ prompt: 'hello there', tokens: deriveTokens(DARK) });
  await m.waitFrame((f) => f.includes('hello there'));
  const { manager } = m.booted.host;
  const second = await manager.create('fake', m.booted.launchCwd, undefined);
  await manager.setVisible([...new Set([...manager.visibleIds(), second.state.id])]);
  await until(() => manager.layout().root.kind === 'split');
  await m.settle(300);
  const f = m.frame();
  expect(['┌', '┐', '└', '┘'].some((c) => f.includes(c))).toBe(false);
  expect(['▗', '▖', '▝', '▘'].some((c) => f.includes(c))).toBe(false);
  const cells = m.spans()[2].spans.flatMap((sp) => [...sp.text].map(() => sp.bg.toString()));
  expect(cells[25] !== cells[26] && cells[27] !== cells[26]).toBe(true);
});

test('without a palette the plain framed layout is unchanged', async () => {
  m = await mountBooted({ prompt: 'hello there' });
  await m.waitFrame((f) => f.includes('hello there'));
  const f = m.frame();
  expect(f.includes('┌')).toBe(true);
});

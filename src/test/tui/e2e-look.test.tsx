import { afterEach, expect, test } from 'bun:test';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { DARK } from '../fixtures/terminal-colors';
import { mountBooted, until } from './e2e-harness';

type Mounted = Awaited<ReturnType<typeof mountBooted>>;
let m: Mounted | undefined;
afterEach(async () => { await m?.destroy(); m = undefined; });

test('with a derived palette the whole app is rounded surfaces, with a gap between roster and pane', async () => {
  m = await mountBooted({ prompt: 'hello there', tokens: deriveTokens(DARK) });
  await m.waitFrame((f) => f.includes('hello there'));
  const { manager } = m.booted.host;
  const second = await manager.create('fake', m.booted.launchCwd, undefined);
  await manager.setVisible([...new Set([...manager.visibleIds(), second.state.id])]);
  await until(() => manager.layout().root.kind === 'split');
  await m.settle(300);
  const f = m.frame();
  expect(['┌', '┐', '└', '┘'].some((c) => f.includes(c))).toBe(false);
  expect(f.includes('▗')).toBe(true);
  const rows = f.split('\n').slice(1, 6);
  expect(rows.every((r) => r[25] === '█' && r[26] === ' ' && r[27] === '█')).toBe(true);
});

test('without a palette the plain framed layout is unchanged', async () => {
  m = await mountBooted({ prompt: 'hello there' });
  await m.waitFrame((f) => f.includes('hello there'));
  const f = m.frame();
  expect(f.includes('┌')).toBe(true);
  expect(f.includes('▗')).toBe(false);
});

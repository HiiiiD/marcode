import { afterEach, expect, test } from 'bun:test';
import type { ToolBlock } from '../../client-core/tool-render';
import { TOOL_GLYPHS } from '../../tui/ui/transcript/tool-glyphs';
import { ToolBlocks } from '../../tui/ui/transcript/tool-blocks';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const show = async (blocks: ToolBlock[]) => { m = await mount(<ToolBlocks blocks={blocks} />); return m.frame(); };

test('every ToolGlyph maps to exactly one character', () => {
  const glyphs = ['terminal', 'file-pen', 'file-plus', 'file-text', 'search', 'folder-search', 'globe', 'list-todo', 'bot', 'send', 'wrench', 'image'] as const;
  for (const g of glyphs) { expect([...TOOL_GLYPHS[g]].length).toBe(1); }
});

test('a command is drawn behind a $ gutter', async () => {
  expect(await show([{ kind: 'command', text: 'yarn test:unit' }])).toContain('$ yarn test:unit');
});

test('todos show done, in-progress and pending marks', async () => {
  const f = await show([{ kind: 'todos', items: [
    { status: 'completed', text: 'one' }, { status: 'in_progress', text: 'two' }, { status: 'pending', text: 'three' },
  ] }]);
  expect(f).toContain('✓ one');
  expect(f).toContain('◉ two');
  expect(f).toContain('○ three');
});

test('a completed todo is struck through', async () => {
  await show([{ kind: 'todos', items: [{ status: 'completed', text: 'done-item' }] }]);
  const span = m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes('done-item'));
  expect(span !== undefined && (span.attributes & 128) !== 0).toBe(true);
});

test('a field shows label and value, a note is plain text', async () => {
  const f = await show([{ kind: 'field', label: 'glob', value: '*.ts' }, { kind: 'note', text: 'not run yet' }]);
  expect(f).toContain('glob');
  expect(f).toContain('*.ts');
  expect(f).toContain('not run yet');
});

test('a long output is clamped with a hidden-lines divider', async () => {
  const text = Array.from({ length: 80 }, (_, i) => `row ${i}`).join('\n');
  m = await mount(<ToolBlocks blocks={[{ kind: 'lines', text, tone: 'output' }]} />, { width: 100, height: 60 });
  expect(m.frame()).toContain('lines hidden');
});

test('diff lines keep their prefixes and an image is a placeholder', async () => {
  const f = await show([{ kind: 'diff', lines: ['-old', '+new'] }, { kind: 'image', dataUri: 'data:image/png;base64,AA' }]);
  expect(f).toContain('-old');
  expect(f).toContain('+new');
  expect(f).toContain('[image]');
});

const PATCH = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;';
const lines = ['-const old = 1;', '+const next = 2;'];
const tokened = (blocks: ToolBlock[], size = { width: 100, height: 40 }) => mount(
  <TokensProvider tokens={deriveTokens(DARK)}><ToolBlocks blocks={blocks} /></TokensProvider>, size,
);
const bgOf = (needle: string) =>
  m!.setup.captureSpans().lines.flatMap((l) => l.spans).find((s) => s.text.includes(needle))?.bg.toString() ?? '';

test('with tokens a unified patch renders natively: both sides visible, added and removed rows tinted differently', async () => {
  m = await tokened([{ kind: 'path', path: '/a.ts' }, { kind: 'diff', lines, unified: PATCH }]);
  const f = m.frame();
  expect(f).toContain('const old');
  expect(f).toContain('const next');
  expect(bgOf('const old') === bgOf('const next')).toBe(false);
});

test('a wide pane shows the patch split, a narrow one unified', async () => {
  m = await tokened([{ kind: 'diff', lines, unified: PATCH }], { width: 160, height: 20 });
  const row = m.frame().split('\n').find((r) => r.includes('const old'));
  expect(row !== undefined && row.includes('const next')).toBe(true);
  m.destroy();
  m = await tokened([{ kind: 'diff', lines, unified: PATCH }], { width: 80, height: 20 });
  const narrow = m.frame().split('\n').find((r) => r.includes('const old'));
  expect(narrow !== undefined && narrow.includes('const next')).toBe(false);
});

test('a patch whose hunk counts lie falls back to the colored lines', async () => {
  m = await tokened([{ kind: 'diff', lines, unified: '@@ -1,5 +1,5 @@\n-const old = 1;\n+const next = 2;' }]);
  expect(m.frame()).toContain('-const old = 1;');
  expect(m.frame()).toContain('+const next = 2;');
});

test('a very large patch falls back to the clamped lines with the hidden-lines note', async () => {
  const body = Array.from({ length: 150 }, (_, i) => `-gone ${i}`).concat(Array.from({ length: 150 }, (_, i) => `+come ${i}`));
  const unified = `@@ -1,150 +1,150 @@\n${body.join('\n')}`;
  m = await tokened([{ kind: 'diff', lines: body, unified }], { width: 100, height: 60 });
  expect(m.frame()).toContain('lines hidden');
});

test('without tokens a patch still renders as prefixed lines', async () => {
  const f = await show([{ kind: 'diff', lines, unified: PATCH }]);
  expect(f).toContain('-const old = 1;');
  expect(f).toContain('+const next = 2;');
});

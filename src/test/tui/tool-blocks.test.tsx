import { afterEach, expect, test } from 'bun:test';
import type { ToolBlock } from '../../client-core/tool-render';
import { TOOL_GLYPHS } from '../../tui/ui/transcript/tool-glyphs';
import { ToolBlocks } from '../../tui/ui/transcript/tool-blocks';
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

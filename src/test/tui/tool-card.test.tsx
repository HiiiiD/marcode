import { afterEach, expect, test } from 'bun:test';
import { ToolCard } from '../../tui/ui/transcript/tool-card';
import { deriveTokens } from '../../tui/ui/tokens/derive-tokens';
import { TokensProvider } from '../../tui/ui/tokens/tokens-provider';
import { DARK } from '../fixtures/terminal-colors';
import { tool } from '../fixtures/protocol';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const rowsOf = (f: string) => f.split(/\r?\n/);

test('an ok call shows glyph, verb and path with no status word', async () => {
  m = await mount(<ToolCard item={tool({ state: 'ok' })} open={false} selected={false} />);
  expect(m.frame()).toContain('$');
  expect(m.frame()).toContain('Bash');
  expect(m.frame()).toContain('yarn test:unit');
  expect(m.frame().includes('failed')).toBe(false);
});

test('a failed call shows the failed pill and a red mark', async () => {
  m = await mount(<ToolCard item={tool({ state: 'error' })} open={false} selected={false} />);
  expect(m.frame()).toContain('failed');
  expect(m.frame()).toContain('✗');
});

test('open shows the input, a Result label and the output', async () => {
  m = await mount(<ToolCard item={tool({ output: { kind: 'text', text: 'line one' } })} open selected={false} />);
  expect(m.frame()).toContain('Result');
  expect(m.frame()).toContain('line one');
});

test('an error shows an Error label, a running call shows Running…', async () => {
  m = await mount(<ToolCard item={tool({ state: 'error', output: { kind: 'text', text: 'boom' } })} open selected={false} />);
  expect(m.frame()).toContain('Error');
  m.destroy();
  m = await mount(<ToolCard item={tool({ state: 'running', output: undefined })} open selected={false} />);
  expect(m.frame()).toContain('Running…');
});

test('headerOnly never shows a body or a chevron', async () => {
  m = await mount(<ToolCard item={tool({ output: { kind: 'text', text: 'hidden-body' } })} open selected={false} headerOnly />);
  expect(m.frame().includes('hidden-body')).toBe(false);
  expect(m.frame().includes('▸') || m.frame().includes('▾')).toBe(false);
});

test('a 200-character path keeps the header on one line with the chevron visible at 50 columns', async () => {
  const long = 'x'.repeat(200);
  m = await mount(<ToolCard item={tool({ state: 'error', tool: { kind: 'command', label: 'Bash', command: long } })} open={false} selected={false} />, { width: 50, height: 10 });
  const header = rowsOf(m.frame()).filter((r) => r.includes('Bash'));
  expect(header.length).toBe(1);
  expect(header[0]).toContain('failed');
  expect(header[0]).toContain('▸');
  expect(rowsOf(m.frame()).every((r) => r.trimEnd().length <= 50)).toBe(true);
});

test('a settled call starts no interval, a running one starts exactly one', async () => {
  const real = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { started++; return real(...a); }) as typeof setInterval;
  try {
    m = await mount(<ToolCard item={tool({ state: 'ok' })} open={false} selected={false} />);
    expect(started).toBe(0);
    m.destroy();
    m = await mount(<ToolCard item={tool({ state: 'running', output: undefined })} open={false} selected={false} />);
    expect(started).toBe(1);
  } finally { globalThis.setInterval = real; }
});

test('an MCP call shows a muted server chip', async () => {
  m = await mount(<ToolCard item={tool({ tool: { kind: 'mcp', label: 'search', server: 'github', tool: 'search' } })} open={false} selected={false} />);
  expect(m.frame()).toContain('github');
});

test('a long MCP verb and server chip keep the header on one line with the pill and chevron at 50 columns', async () => {
  const mcp = { kind: 'mcp', label: 'mcp__chrome-devtools__performance_analyze_insight', server: 'chrome-devtools', tool: 'performance_analyze_insight' } as const;
  m = await mount(<ToolCard item={tool({ state: 'error', tool: mcp })} open={false} selected={false} />, { width: 50, height: 10 });
  const rows = rowsOf(m.frame());
  const header = rows.filter((r) => r.includes('chrome-devtools'));
  expect(header.length).toBe(1);
  expect(header[0]).toContain('failed');
  expect(header[0]).toContain('▸');
  expect(rows.every((r) => r.trimEnd().length <= 50)).toBe(true);
});

test('a folded permission shows its state in the header and a denied call drops the failed pill', async () => {
  m = await mount(<ToolCard item={tool({ state: 'error' })} permission={{ state: 'denied', reason: 'too risky' }} open={false} selected={false} />);
  const line = rowsOf(m.frame()).find((r) => r.includes('Bash')) ?? '';
  expect(line).toContain('denied');
  expect(line.includes('failed')).toBe(false);
  m.destroy();
  m = await mount(<ToolCard item={tool({ state: 'ok' })} permission={{ state: 'allowed' }} open={false} selected={false} />);
  expect(m.frame()).toContain('allowed');
  m.destroy();
  m = await mount(<ToolCard item={tool({ state: 'running', output: undefined })} permission={{ state: 'pending' }} open={false} selected={false} />);
  expect(m.frame()).toContain('awaiting approval');
});

test('a denial reason shows in the open body', async () => {
  m = await mount(<ToolCard item={tool({ state: 'error' })} permission={{ state: 'denied', reason: 'too risky' }} open selected={false} />);
  expect(m.frame()).toContain('too risky');
});

test('the permission state survives a 50-column header', async () => {
  m = await mount(<ToolCard item={tool({ state: 'running', output: undefined, tool: { kind: 'command', label: 'Bash', command: 'x'.repeat(200) } })} permission={{ state: 'pending' }} open={false} selected={false} />, { width: 50, height: 10 });
  const line = rowsOf(m.frame()).find((r) => r.includes('Bash')) ?? '';
  expect(line).toContain('awaiting approval');
  expect(line).toContain('▸');
});

const editItem = () => tool({
  tool: {
    kind: 'file-edit', label: 'Edit',
    files: [{ path: '/a.ts', op: 'modify', unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const old = 1;\n+const next = 2;' }],
  },
  output: undefined,
});
const widest = (f: string) => Math.max(...rowsOf(f).map((r) => r.trimEnd().length));

test('with tokens an open edit card widens past 100 columns so the diff can go split', async () => {
  m = await mount(
    <TokensProvider tokens={deriveTokens(DARK)}><ToolCard item={editItem()} open selected={false} /></TokensProvider>,
    { width: 200, height: 20 },
  );
  const row = rowsOf(m.frame()).find((r) => r.includes('const old'));
  expect(row !== undefined && row.includes('const next')).toBe(true);
  expect(widest(m.frame()) > 100).toBe(true);
});

test('without tokens the same card stays at the 100 column measure', async () => {
  m = await mount(<ToolCard item={editItem()} open selected={false} />, { width: 200, height: 20 });
  expect(widest(m.frame()) <= 100).toBe(true);
});

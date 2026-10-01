import { afterEach, expect, test } from 'bun:test';
import { ToolCard } from '../../tui/ui/transcript/tool-card';
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

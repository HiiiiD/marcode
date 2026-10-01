import { afterEach, expect, test } from 'bun:test';
import { PermissionCard } from '../../tui/ui/transcript/permission-card';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const header = { glyph: 'terminal', verb: 'Bash', primary: 'cd /tmp && python -c "\nimport pypdf\nprint(1)\n" 2>&1 | head -40', mono: true } as const;
const rowsOf = (f: string) => f.split(/\r?\n/);

test('a multi-line command is clipped to one header line inside a card', async () => {
  m = await mount(<PermissionCard header={header} state="allowed" selected={false} />, { width: 60, height: 10 });
  const rows = rowsOf(m.frame());
  expect(rows.filter((r) => r.includes('Bash')).length).toBe(1);
  expect(rows.some((r) => r.includes('import pypdf'))).toBe(false);
  expect(rows.some((r) => r.includes('┌'))).toBe(true);
  expect(rows.every((r) => r.trimEnd().length <= 60)).toBe(true);
});

test('the state stays visible at 50 columns for each outcome', async () => {
  for (const [state, mark] of [['allowed', '✓'], ['denied', '✗'], ['pending', '?']] as const) {
    m = await mount(<PermissionCard header={header} state={state} selected={false} />, { width: 50, height: 10 });
    const line = rowsOf(m.frame()).find((r) => r.includes('Bash')) ?? '';
    expect(line).toContain(state);
    expect(line).toContain(mark);
    m.destroy();
  }
  m = undefined;
});

test('a denial reason is shown under the header', async () => {
  m = await mount(<PermissionCard header={header} state="denied" reason="too risky" selected={false} />);
  expect(m.frame()).toContain('too risky');
});

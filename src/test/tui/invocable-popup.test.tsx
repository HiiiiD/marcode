import { afterEach, expect, test } from 'bun:test';
import { Composer } from '../../tui/ui/composer';
import { snapshot } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const sends = () => m!.posted.filter((p) => p.t === 'send');
const entries = [
  { name: 'review', description: 'Review a diff', kind: 'skill' },
  { name: 'release', description: 'Cut a release', kind: 'skill' },
  { name: 'compact', description: 'Compact context', kind: 'command' },
] as never[];

async function open() {
  m = await mount(<Composer sessionId="s1" focused />);
  await m.fromHost(hydrateMsg({ snapshots: [snapshot('s1')] }));
  await m.fromHost({ t: 'session-invocables', id: 's1', entries });
}

test('typing / lists every entry', async () => {
  await open();
  await m!.type('/');
  expect(m!.frame()).toContain('/review');
  expect(m!.frame()).toContain('/compact');
});

test('typing narrows the list', async () => {
  await open();
  await m!.type('/rel');
  expect(m!.frame()).toContain('/release');
  expect(m!.frame().includes('/compact')).toBe(false);
});

test('Enter picks instead of sending, then inserts the name', async () => {
  await open();
  await m!.type('/comp');
  await m!.press('return');
  expect(sends().length).toBe(0);
  expect(m!.frame()).toContain('/compact');
});

test('no menu once whitespace is typed', async () => {
  await open();
  await m!.type('/review ');
  expect(m!.frame().includes('Review a diff')).toBe(false);
});

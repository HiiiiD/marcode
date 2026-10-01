import { afterEach, expect, test } from 'bun:test';
import { StatusLine } from '../../tui/ui/status-line';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const withEffort = summary('s1', { effort: 'high', permissionMode: 'plan' });

test('shows display name, model, effort and permission mode', async () => {
  m = await mount(<StatusLine sessionId="s1" width={80} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('Fake · fake-large · high · plan');
});

test('truncates with an ellipsis to the width', async () => {
  m = await mount(<StatusLine sessionId="s1" width={12} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('Fake · fake…');
  expect(m.frame()).not.toContain('fake-large');
});

test('with no session it offers a new one', async () => {
  m = await mount(<StatusLine sessionId={null} width={80} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  expect(m.frame()).toContain('no session — Ctrl+N new');
});

test('hints the picker keys when the session is ours and there is room', async () => {
  m = await mount(<StatusLine sessionId="s1" width={100} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('^P model · ^E effort · ⇧Tab mode');
});

test('drops the hint before it would truncate the session line', async () => {
  m = await mount(<StatusLine sessionId="s1" width={40} />);
  await m.fromHost(hydrateMsg({ sessions: [withEffort], snapshots: [snapshot('s1', withEffort)] }));
  expect(m.frame()).toContain('Fake · fake-large · high · plan');
  expect(m.frame().includes('^P')).toBe(false);
});

test('a session owned by another host gets no hint', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 1 } });
  m = await mount(<StatusLine sessionId="s1" width={100} />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', foreign)] }));
  expect(m.frame().includes('^P')).toBe(false);
});

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

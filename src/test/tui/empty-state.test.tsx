import { afterEach, expect, test } from 'bun:test';
import { EmptyState } from '../../tui/ui/empty-state';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const empty = { sessions: [], snapshots: [], catalog: [] };

test('probing says so and makes no diagnosis', async () => {
  m = await mount(<EmptyState loginCommands={{}} />);
  await m.fromHost(hydrateMsg({ ...empty, probing: true }));
  expect(m.frame()).toContain('Checking providers…');
  expect(m.frame()).not.toContain('marcode config');
});

test('probing still shows a kept prompt', async () => {
  m = await mount(<EmptyState pendingPrompt="fix the tests" loginCommands={{}} />);
  await m.fromHost(hydrateMsg({ ...empty, probing: true }));
  expect(m.frame()).toContain('Checking providers…');
  expect(m.frame()).toContain('Your prompt is kept: fix the tests');
});

test('nothing enabled points at the config command', async () => {
  m = await mount(<EmptyState loginCommands={{}} />);
  await m.fromHost(hydrateMsg({ ...empty, unavailable: [], probing: false }));
  expect(m.frame()).toContain('No provider is enabled. Run `marcode config` to enable one.');
});

test('an unavailable provider shows its reason, its login command and the kept prompt', async () => {
  m = await mount(<EmptyState pendingPrompt="fix the tests" loginCommands={{ claude: 'claude auth login' }} />);
  await m.fromHost(hydrateMsg({
    ...empty, probing: false,
    unavailable: [
      { id: 'claude', displayName: 'Claude', reason: 'not signed in' },
      { id: 'codex', displayName: 'Codex', reason: 'not installed' },
    ],
  }));
  const f = m.frame();
  expect(f).toContain('Claude: not signed in');
  expect(f).toContain('run: marcode login claude');
  expect(f).toContain('Codex: not installed');
  expect(f).not.toContain('marcode login codex');
  expect(f).toContain('Press Ctrl+R to check again.');
  expect(f).toContain('Your prompt is kept: fix the tests');
});

test('an available catalog with no sessions invites a new one and keeps the prompt', async () => {
  m = await mount(<EmptyState pendingPrompt="hello there" loginCommands={{}} />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  const f = m.frame();
  expect(f).toContain('No sessions yet. Press Ctrl+N to start one:');
  expect(f).toContain('Fake');
  expect(f).toContain('Your prompt is kept: hello there');
});

test('sessions in the roster but none shown points at the roster', async () => {
  m = await mount(<EmptyState loginCommands={{}} />);
  await m.fromHost(hydrateMsg());
  const f = m.frame();
  expect(f).toContain('No session open. Open one from the roster (Ctrl+B, then Enter), or press Ctrl+N for a new one:');
  expect(f).not.toContain('No sessions yet');
  expect(f).toContain('Fake');
});

import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { PermissionRequest } from '../../protocol/messages';
import { App } from '../../tui/ui/app';
import { catalog, singlePaneLayout, snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
const settleEscape = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); await m!.setup.renderOnce(); };
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
// Transcript markdown lays out asynchronously; the first frame after a hydrate can still be blank.
const tick = () => new Promise((r) => setTimeout(r, 10));
const perm: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf x' } };

test('resumes the last session and posts its leaf as the visible set', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'api-fix' })],
    snapshots: [snapshot('s1', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'hello there' }] })],
  }));
  await tick();
  await m.fromHost();
  expect(m.frame()).toContain('hello there');
  expect(m.posted.some((p) => p.t === 'set-visible' && p.sessionIds.length === 1 && p.sessionIds[0] === 's1')).toBe(true);
});

test('no set-visible is posted before the first hydrate', async () => {
  m = await mount(<App {...props} />);
  await tick();
  expect(m.posted.filter((p) => p.t === 'set-visible').length).toBe(0);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], layout: { root: { kind: 'leaf', sessionId: null, size: 100 }, presets: [] } }));
  expect(m.posted.filter((p) => p.t === 'set-visible').length).toBe(1);
});

test('a prompt argument creates a session in the launch cwd with the prompt as seed, then focuses it', async () => {
  m = await mount(<App {...props} prompt="fix the tests" />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [] }));
  const creates = m.posted.filter((p) => p.t === 'create-session');
  expect(creates.length).toBe(1);
  const create = creates[0];
  expect(create?.t === 'create-session' && create.cwd).toBe('/repo');
  expect(create?.t === 'create-session' && create.seed?.text).toBe('fix the tests');
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('new1')] }, { t: 'session-snapshot', session: snapshot('new1') });
  expect(m.posted.some((p) => p.t === 'set-visible' && p.sessionIds.includes('new1'))).toBe(true);
  expect(m.posted.some((p) => p.t === 'focus-pane' && p.sessionId === 'new1')).toBe(true);
});

test('a prompt argument with no provider is kept on screen, not sent', async () => {
  m = await mount(<App {...props} prompt="fix the tests" />);
  await m.fromHost(hydrateMsg({ sessions: [], snapshots: [], catalog: [], unavailable: [{ id: 'claude', displayName: 'Claude', reason: 'not signed in' }], probing: false }));
  expect(m.posted.some((p) => p.t === 'create-session')).toBe(false);
  expect(m.frame()).toContain('Your prompt is kept: fix the tests');
});

test('Ctrl+B toggles the roster and focusing another session posts set-visible for it', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
    snapshots: [snapshot('s1')],
  }));
  expect(m.frame()).toContain('two');
  await m.press('b', { ctrl: true });
  expect(m.frame()).not.toContain('two');
  await m.press('b', { ctrl: true });
  await m.press('tab');
  await m.press('tab');
  await m.press('j');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'set-visible' && p.sessionIds.includes('s2'))).toBe(true);
});

test('a narrow terminal hides the roster until Ctrl+B shows it as an overlay', async () => {
  m = await mount(<App {...props} />, { width: 80, height: 20 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { name: 'one' }), summary('s2', { name: 'two' })],
    snapshots: [snapshot('s1')],
  }));
  expect(m.frame()).not.toContain('two');
  await m.press('b', { ctrl: true });
  expect(m.frame()).toContain('two');
});

test('a terminal narrower than 40 columns still renders without throwing', async () => {
  m = await mount(<App {...props} />, { width: 30, height: 12 });
  await m.fromHost(hydrateMsg());
  expect(m.frame().length).toBeGreaterThan(0);
});

test('a resize while streaming keeps the newest text visible', async () => {
  m = await mount(<App {...props} />, { width: 100, height: 14 });
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status: 'running' })], snapshots: [snapshot('s1', { status: 'running', items: [{ id: 'a1', ts: 1, role: 'assistant', text: 'start' }] })] }));
  await m.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'delta', itemId: 'a1', field: 'text', delta: '\n'.repeat(30) + 'the newest line' } });
  await act(async () => { m!.setup.resize(70, 12); });
  await m.setup.renderOnce();
  expect(m.frame()).toContain('the newest line');
});

test('an approval arriving over a draft takes the keyboard and the draft survives it', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg());
  await m.type('half a thought');
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm] }) });
  expect(m.frame()).toContain('[y] allow');
  await m.press('tab');
  await m.press('y');
  expect(m.posted.filter((p) => p.t === 'permission-decision').length).toBe(1);
  await m.fromHost({ t: 'session-snapshot', session: snapshot('s1', { pending: [] }) });
  expect(m.frame()).toContain('half a thought');
});

test('when the owner lets go of the focused session the composer returns', async () => {
  const foreign = summary('s1', { owner: { host: 'vscode', pid: 4812 } });
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ sessions: [foreign], snapshots: [snapshot('s1', { owner: foreign.owner })], layout: singlePaneLayout('s1') }));
  expect(m.frame()).toContain('Read-only here');
  await m.fromHost({ t: 'sessions-changed', sessions: [summary('s1')] });
  expect(m.frame()).not.toContain('Read-only here');
  await m.type('now mine');
  await m.press('return');
  expect(m.posted.filter((p) => p.t === 'send').length).toBe(1);
});

test('the first boot warning is the initial notice', async () => {
  m = await mount(<App {...props} initialNotice="config.json could not be read; using the defaults." />);
  await m.fromHost(hydrateMsg());
  expect(m.frame()).toContain('config.json could not be read; using the defaults.');
});

test('a later notice from the subscriber reaches the notice line, and unmount unsubscribes', async () => {
  let push: ((text: string) => void) | undefined;
  let unsubscribed = 0;
  const subscribe = (cb: (text: string) => void) => { push = cb; return () => { unsubscribed++; }; };
  m = await mount(<App {...props} subscribeNotices={subscribe} />);
  await m.fromHost(hydrateMsg());
  await act(async () => { push?.('config.json changed — restart to apply'); });
  await m.setup.renderOnce();
  expect(m.frame()).toContain('config.json changed — restart to apply');
  m.destroy();
  m = undefined;
  expect(unsubscribed).toBe(1);
});

test('Ctrl+P opens the model dialog and picking a row posts set-model', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ catalog: catalog() }));
  await m.press('p', { ctrl: true });
  expect(m.frame()).toContain('Search:');
  await m.press('down');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'set-model' && p.model === 'fake-small')).toBe(true);
  expect(m.frame().includes('Search:')).toBe(false);
});

test('Ctrl+E opens the effort row and Right posts the next level', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ catalog: catalog() }));
  await m.press('e', { ctrl: true });
  expect(m.frame()).toContain('Effort');
  await m.press('right');
  expect(m.posted.some((p) => p.t === 'set-effort' && p.effort === 'high')).toBe(true);
});

test('Shift+Tab opens the permission mode dialog and Ctrl+R still refreshes the catalog', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ catalog: catalog() }));
  await m.press('tab', { shift: true });
  expect(m.frame()).toContain('Permission mode');
  await m.press('escape');
  await settleEscape();
  await m.press('r', { ctrl: true });
  expect(m.posted.some((p) => p.t === 'refresh-catalog')).toBe(true);
  expect(m.posted.some((p) => p.t === 'set-permission-mode')).toBe(false);
});

test('while a picker is open, other global chords are inert and Esc closes it', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({ catalog: catalog() }));
  await m.press('p', { ctrl: true });
  await m.press('n', { ctrl: true });
  expect(m.frame().includes('New session')).toBe(false);
  await m.press('escape');
  await settleEscape();
  expect(m.frame().includes('Search:')).toBe(false);
});

import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { PermissionRequest, QuestionRequest } from '../../protocol/messages';
import { App } from '../../tui/ui/app';
import { snapshot, summary } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const perm: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf x' } };
const emptyLeaf = { root: { kind: 'leaf' as const, sessionId: null, size: 100 }, presets: [] };
const lastVisible = () => m!.posted.filter((p) => p.t === 'set-visible').at(-1);
const settleEscape = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  await m!.setup.renderOnce();
};

async function twoSessions() {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(hydrateMsg({
    sessions: [summary('a', { name: 'alpha' }), summary('b', { name: 'beta' })],
    snapshots: [snapshot('a'), snapshot('b', { items: [{ id: 'u1', ts: 1, role: 'user', text: 'beta says hi' }] })],
    layout: { root: { kind: 'leaf', sessionId: 'a', size: 100 }, presets: [] },
  }));
  expect(lastVisible()).toEqual({ t: 'set-visible', sessionIds: ['a'] });
}

test('closing the focused session from the roster focuses the next one once the host drops it', async () => {
  await twoSessions();
  await m!.press('tab');
  await m!.press('tab');
  await m!.press('x');
  expect(m!.posted.some((p) => p.t === 'close-session' && p.id === 'a')).toBe(true);
  await m!.fromHost({ t: 'sessions-changed', sessions: [summary('b', { name: 'beta' })] });
  await new Promise((r) => setTimeout(r, 10));
  await m!.fromHost();
  expect(lastVisible()).toEqual({ t: 'set-visible', sessionIds: ['b'] });
  expect(m!.frame()).toContain('beta says hi');
});

test('a hidden focused session (leaf emptied, still in the roster) is not re-focused; another one is', async () => {
  await twoSessions();
  await m!.fromHost({ t: 'layout-changed', layout: emptyLeaf });
  expect(lastVisible()).toEqual({ t: 'set-visible', sessionIds: ['b'] });
});

test('hiding the only session leaves the empty state, and typing sends nothing', async () => {
  m = await mount(<App {...props} />, { width: 80, height: 20 });
  await m.fromHost(hydrateMsg());
  await m.fromHost({ t: 'layout-changed', layout: emptyLeaf });
  expect(m.frame()).toContain('No session open.');
  await m.type('hello');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
  expect(m.posted.filter((p) => p.t === 'set-visible').length).toBe(1);
});

test('closing the last session leaves the empty state with no composer', async () => {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg());
  await m.fromHost({ t: 'sessions-changed', sessions: [] });
  expect(m.frame()).not.toContain('Message — Enter send');
  await m.type('hello');
  await m.press('return');
  expect(m.posted.some((p) => p.t === 'send')).toBe(false);
});

test('a hidden session focused again from the roster comes back', async () => {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  await m.fromHost(hydrateMsg());
  await m.fromHost({ t: 'layout-changed', layout: emptyLeaf });
  await m.press('return');
  expect(lastVisible()).toEqual({ t: 'set-visible', sessionIds: ['s1'] });
  expect(m.frame()).toContain('Message — Enter send');
});

async function awaitingApproval() {
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { status: 'awaiting-approval' })],
    snapshots: [snapshot('s1', { status: 'awaiting-approval', pending: [perm] })],
  }));
  expect(m.frame()).toContain('[y] allow');
}

test('Esc on a permission prompt interrupts the turn', async () => {
  await awaitingApproval();
  await m!.press('escape');
  await settleEscape();
  expect(m!.posted.filter((p) => p.t === 'interrupt').length).toBe(1);
});

test('Ctrl+C while awaiting approval interrupts, and a second press quits', async () => {
  let quit = 0;
  m = await mount(<App {...props} onQuit={() => { quit++; }} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { status: 'awaiting-approval' })],
    snapshots: [snapshot('s1', { status: 'awaiting-approval', pending: [perm] })],
  }));
  await m.press('c', { ctrl: true });
  expect(quit).toBe(0);
  expect(m.posted.filter((p) => p.t === 'interrupt').length).toBe(1);
  await m.press('c', { ctrl: true });
  expect(quit).toBe(1);
  expect(m.posted.filter((p) => p.t === 'interrupt').length).toBe(1);
});

test('Esc inside the deny-reason entry only goes back to the choice', async () => {
  await awaitingApproval();
  await m!.press('n');
  expect(m!.frame()).toContain('deny reason');
  await m!.press('escape');
  await settleEscape();
  expect(m!.frame()).toContain('[y] allow');
  expect(m!.posted.some((p) => p.t === 'interrupt')).toBe(false);
});

test('Esc inside a question\'s free-text entry only goes back to the options', async () => {
  const other: QuestionRequest = {
    requestId: 'q1', blocking: true,
    questions: [{ id: 'o', header: 'O', question: 'Pick or say?', multiSelect: false, allowOther: true, secret: false,
      options: [{ label: 'Yes', description: '' }] }],
  };
  m = await mount(<App {...props} />);
  await m.fromHost(hydrateMsg({
    sessions: [summary('s1', { status: 'running' })],
    snapshots: [snapshot('s1', { status: 'running', pendingQuestions: [other] })],
  }));
  await m.press('down');
  await m.press('return');
  await m.press('escape');
  await settleEscape();
  expect(m.posted.some((p) => p.t === 'interrupt')).toBe(false);
  await m.press('escape');
  await settleEscape();
  expect(m.posted.filter((p) => p.t === 'interrupt').length).toBe(1);
});

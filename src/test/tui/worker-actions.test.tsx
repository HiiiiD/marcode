import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { App } from '../../tui/ui/app';
import { snapshot, summary, tool } from '../fixtures/protocol';
import type { SessionSummary, TranscriptItem } from '../../protocol/messages';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const props = { launchCwd: '/repo', forceNew: false, loginCommands: {}, onQuit: () => {} };
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const worker = (id: string, state: 'running' | 'ok', name: string): TranscriptItem => tool({
  id, toolId: `t-${id}`, ts: Date.now(), state,
  tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: name, provider: 'codex', childSessionId: `s-${id}`, groupId: 'g1' },
});
const team = [worker('w1', 'running', 'scout'), worker('w2', 'ok', 'fixer')];

async function boot(over: Partial<SessionSummary> = {}) {
  m = await mount(<App {...props} />, { width: 120, height: 30 });
  const status = over.status ?? 'running';
  await m.fromHost(hydrateMsg({ sessions: [summary('s1', { status, ...over })], snapshots: [snapshot('s1', { ...over, status, items: team })] }));
  await m.press('tab');
}
const posted = (t: string) => m!.posted.filter((p) => p.t === t);

test('a team folds into one row and opens to list its workers', async () => {
  await boot();
  const f = m!.frame();
  expect(f).toContain('2 workers');
  expect(f).toContain('1 running');
  expect(f).toContain('1 done');
  expect(f.includes('Worker')).toBe(false);
  const teamLine = f.split('\n').find((r) => r.includes('2 workers')) ?? '';
  expect([...teamLine].filter((c) => c === '◎').length).toBe(2);
  expect(teamLine.includes('scout') || teamLine.includes('fixer')).toBe(false);
  await m!.press('return');
  expect(m!.frame().split('\n').filter((r) => r.includes('Worker')).length).toBe(2);
});

test('s stops a running worker, and only a running one', async () => {
  await boot();
  await m!.press('return');
  await m!.press('j');
  await m!.press('s');
  expect(posted('interrupt').map((p) => p.t === 'interrupt' && p.id)).toEqual(['s-w1']);
  await m!.press('j');
  await m!.press('s');
  expect(posted('interrupt').length).toBe(1);
  expect(m!.frame()).toContain('not running');
});

test('m messages a worker: one send to its session, nothing written to the parent draft', async () => {
  await boot({ status: 'idle' });
  await m!.press('return');
  await m!.press('j');
  await m!.press('j');
  await m!.press('m');
  expect(m!.frame()).toContain('To fixer');
  const draftsBefore = posted('set-draft').length;
  await m!.type('look at the lexer');
  await m!.press('return');
  await wait(400);
  const sends = posted('send');
  expect(sends.length).toBe(1);
  expect(sends[0]?.t === 'send' && [sends[0].id, sends[0].text]).toEqual(['s-w2', 'look at the lexer']);
  expect(posted('set-draft').length).toBe(draftsBefore);
  expect(m!.frame().includes('To fixer')).toBe(false);
});

test('Esc in the message bar goes back without interrupting the running parent', async () => {
  await boot();
  await m!.press('return');
  await m!.press('j');
  await m!.press('m');
  expect(m!.frame()).toContain('To scout');
  await m!.press('escape');
  await wait(100);
  await m!.setup.renderOnce();
  expect(posted('interrupt').length).toBe(0);
  expect(m!.frame().includes('To scout')).toBe(false);
});

test('a pane owned by another host reaches no worker', async () => {
  await boot({ owner: { host: 'vscode', pid: 7 } });
  await m!.press('return');
  await m!.press('j');
  await m!.press('s');
  await m!.press('m');
  expect(posted('interrupt').length).toBe(0);
  expect(m!.frame().includes('To scout')).toBe(false);
});

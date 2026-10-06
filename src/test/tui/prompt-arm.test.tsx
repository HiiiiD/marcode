import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { PermissionRequest, QuestionRequest } from '../../protocol/messages';
import { BottomSlotView } from '../../tui/ui/bottom-slot';
import { snapshot } from '../fixtures/protocol';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const ARM = 300;
const perm: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf x' } };
const question: QuestionRequest = {
  requestId: 'q1', blocking: true,
  questions: [{ id: 'scope', header: 'Scope', question: 'Which one?', multiSelect: false, allowOther: false, secret: false,
    options: [{ label: 'Cards only', description: '' }, { label: 'Both', description: '' }] }],
};
const decisions = () => m!.posted.filter((p) => p.t === 'permission-decision');
const answers = () => m!.posted.filter((p) => p.t === 'question-answer');
const pastArm = () => act(async () => { await new Promise((r) => setTimeout(r, ARM + 30)); });

async function armed() {
  m = await mount(<BottomSlotView sessionId="s1" focused />, undefined, { promptArmMs: ARM });
  await m.fromHost(hydrateMsg());
}

test('a y typed the moment a permission arrives does not answer it', async () => {
  await armed();
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm] }) });
  await m!.pressMany(['y']);
  expect(decisions().length).toBe(0);
  await m!.pressMany(['n', 'o', 'return']);
  expect(decisions().length).toBe(0);
  await pastArm();
  await m!.press('y');
  await m!.press('y');
  expect(decisions().length).toBe(1);
});

test('an Enter pressed the moment a permission arrives does not answer it', async () => {
  await armed();
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm] }) });
  await m!.pressMany(['return']);
  expect(decisions().length).toBe(0);
});

test('an Enter pressed the moment a question arrives does not answer it; once armed it does', async () => {
  await armed();
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', { pendingQuestions: [question] }) });
  await m!.pressMany(['down', 'return']);
  expect(answers().length).toBe(0);
  await pastArm();
  await m!.press('return');
  expect(answers().length).toBe(1);
  const a = answers()[0];
  expect(a?.t === 'question-answer' && a.answers.scope).toEqual(['Cards only']);
});

test('two pending: deny with a reason posts, and the next request takes over once the host settles the first', async () => {
  const perm2: PermissionRequest = { requestId: 'r2', tool: { kind: 'command', label: 'Bash', command: 'ls' } };
  await armed();
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm, perm2] }) });
  await pastArm();
  await m!.press('n');
  await m!.pressMany(['a', 'b', 'return']);
  expect(decisions().length).toBe(1);
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', { status: 'awaiting-approval', pending: [perm2] }) });
  await pastArm();
  await m!.press('y');
  expect(decisions().length).toBe(2);
});

test('a nested replace patch settles the first request and hands the prompt to the next', async () => {
  const mk = (id: string, state: 'pending' | 'denied') => ({
    id: `i-${id}`, ts: 1, role: 'permission' as const, requestId: id, state,
    tool: { kind: 'command' as const, label: 'Bash', command: id },
  });
  const sub = {
    id: 'sub', ts: 1, role: 'tool' as const, toolId: 'task', state: 'running' as const,
    tool: { kind: 'subagent' as const, label: 'Task', action: 'spawn' as const },
    children: [mk('r1', 'pending'), mk('r2', 'pending')],
  };
  await armed();
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', {
    status: 'awaiting-approval', items: [sub],
    pending: [{ requestId: 'r1', tool: sub.children[0].tool }, { requestId: 'r2', tool: sub.children[1].tool }],
  }) });
  await pastArm();
  await m!.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'replace', item: mk('r1', 'denied'), parentItemId: 'sub' } } as never);
  await pastArm();
  await m!.press('y');
  const d = decisions();
  expect(d.length).toBe(1);
  expect(d[0].t === 'permission-decision' && d[0].requestId).toBe('r2');
});

test('a wholesale parent replace that carries a settled child also clears its pending request', async () => {
  const mk = (id: string, state: 'pending' | 'denied') => ({
    id: `i-${id}`, ts: 1, role: 'permission' as const, requestId: id, state,
    tool: { kind: 'command' as const, label: 'Bash', command: id },
  });
  const sub = (children: ReturnType<typeof mk>[]) => ({
    id: 'sub', ts: 1, role: 'tool' as const, toolId: 'task', state: 'ok' as const,
    tool: { kind: 'subagent' as const, label: 'Task', action: 'spawn' as const }, children,
  });
  await armed();
  await m!.fromHost({ t: 'session-snapshot', session: snapshot('s1', {
    status: 'awaiting-approval', items: [sub([mk('r1', 'pending'), mk('r2', 'pending')])],
    pending: [{ requestId: 'r1', tool: mk('r1', 'pending').tool }, { requestId: 'r2', tool: mk('r2', 'pending').tool }],
  }) });
  await m!.fromHost({ t: 'session-patch', id: 's1', patch: { op: 'replace', item: sub([mk('r1', 'denied'), mk('r2', 'pending')]) } } as never);
  await pastArm();
  await m!.press('y');
  const d = decisions();
  expect(d.length).toBe(1);
  expect(d[0].t === 'permission-decision' && d[0].requestId).toBe('r2');
});

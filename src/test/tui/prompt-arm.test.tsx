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

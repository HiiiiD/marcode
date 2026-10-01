import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { PermissionRequest, WebviewToHost } from '../../protocol/messages';
import { ApprovalPrompt } from '../../tui/ui/approval-prompt';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const req: PermissionRequest = { requestId: 'r1', tool: { kind: 'command', label: 'Bash', command: 'rm -rf build' } };
const decisions = () => m!.posted.filter((p) => p.t === 'permission-decision');
const deny = (reason?: string): Extract<WebviewToHost, { t: 'permission-decision' }> => ({
  t: 'permission-decision', id: 's1', requestId: 'r1', decision: reason === undefined ? { allow: false } : { allow: false, reason },
});

test('shows the tool and the keys', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  expect(m.frame()).toContain('Bash');
  expect(m.frame()).toContain('rm -rf build');
  expect(m.frame()).toContain('[y] allow');
});

test('y allows exactly once', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('y');
  await m.press('y');
  expect(decisions()).toEqual([{ t: 'permission-decision', id: 's1', requestId: 'r1', decision: { allow: true } }]);
});

test('Enter on the default highlight allows once', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('return');
  await m.press('return');
  expect(decisions()).toEqual([{ t: 'permission-decision', id: 's1', requestId: 'r1', decision: { allow: true } }]);
});

test('n then a reason denies with that reason', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.type('Too risky');
  expect(m.frame()).toContain('Too risky');
  await m.press('return');
  expect(decisions()).toEqual([deny('Too risky')]);
});

test('n then Enter denies without a reason', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.press('return');
  expect(decisions()).toEqual([deny()]);
});

test('typing y and n inside the reason does not allow or deny', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.type('yn yes');
  expect(decisions().length).toBe(0);
  expect(m.frame()).toContain('yn yes');
  await m.press('return');
  expect(decisions()).toEqual([deny('yn yes')]);
});

test('backspace edits the reason', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.type('abcd');
  await m.press('backspace');
  await m.press('return');
  expect(decisions()).toEqual([deny('abc')]);
});

test('Esc in the reason returns to the choice', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused />);
  await m.press('n');
  await m.type('x');
  await m.press('escape');
  // a lone ESC is held back by the input parser until its disambiguation timeout
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  await m.fromHost();
  expect(m.frame()).toContain('[y] allow');
  expect(decisions().length).toBe(0);
  await m.press('y');
  expect(decisions().length).toBe(1);
});

test('an unfocused prompt ignores keys', async () => {
  m = await mount(<ApprovalPrompt sessionId="s1" request={req} focused={false} />);
  await m.press('y');
  await m.press('n');
  expect(decisions().length).toBe(0);
});

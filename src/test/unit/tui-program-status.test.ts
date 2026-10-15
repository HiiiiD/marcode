import * as assert from 'assert';
import type { SessionSummary } from '../../protocol/messages';
import { programStatus } from '../../tui/view/program-status';

const s = (id: string, status: SessionSummary['status'], name = ''): SessionSummary => ({ id, status, name, title: `t-${id}` }) as SessionSummary;

suite('tui program status', () => {
  test('no sessions is idle', () => { assert.deepStrictEqual(programStatus([]), { state: 'idle' }); });
  test('running sessions are counted', () => {
    const r = programStatus([s('a', 'running'), s('b', 'running'), s('c', 'idle')]);
    assert.deepStrictEqual(r, { state: 'working', app: 'marcode', message: '2 sessions running' });
  });
  test('approval outranks running and names a lone session', () => {
    const r = programStatus([s('a', 'running'), s('b', 'awaiting-approval', 'Fix')]);
    assert.deepStrictEqual(r, { state: 'blocked', kind: 'permission', app: 'marcode', title: 'Fix', message: 'Fix awaits approval' });
  });
  test('several approvals are counted', () => {
    const r = programStatus([s('a', 'awaiting-approval'), s('b', 'awaiting-approval')]);
    assert.strictEqual(r.state === 'blocked' && r.message, '2 sessions await approval');
  });

  test('a session waiting on a question reports kind question', () => {
    const r = programStatus([{ ...s('a', 'awaiting-approval', 'Ask'), waitingOn: 'question' }]);
    assert.deepStrictEqual(r, { state: 'blocked', kind: 'question', app: 'marcode', title: 'Ask', message: 'Ask awaits an answer' });
  });
  test('any permission among the waiting sessions keeps kind permission', () => {
    const r = programStatus([{ ...s('a', 'awaiting-approval'), waitingOn: 'question' }, { ...s('b', 'awaiting-approval'), waitingOn: 'permission' }]);
    assert.strictEqual(r.state === 'blocked' && r.kind, 'permission');
  });
});

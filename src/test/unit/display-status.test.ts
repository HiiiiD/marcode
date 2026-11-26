import * as assert from 'assert';
import { displayStatus } from '../../client-core/display-status';

suite('displayStatus', () => {
  test('a session with no nested children shows its own status', () => {
    for (const status of ['idle', 'running', 'awaiting-approval', 'error'] as const) {
      assert.strictEqual(displayStatus({ status }), status);
    }
  });

  test('an idle parent shows working while nested children run', () => {
    assert.strictEqual(displayStatus({ status: 'idle', subagents: { running: 2, awaitingApproval: 0 } }), 'running');
  });

  test('an idle parent shows needs-you while a nested child waits on approval', () => {
    assert.strictEqual(displayStatus({ status: 'idle', subagents: { running: 1, awaitingApproval: 1 } }), 'awaiting-approval');
    assert.strictEqual(displayStatus({ status: 'running', subagents: { running: 1, awaitingApproval: 1 } }), 'awaiting-approval');
  });

  test('a parent of its own waiting or failed keeps that status', () => {
    const subagents = { running: 1, awaitingApproval: 0 };
    assert.strictEqual(displayStatus({ status: 'awaiting-approval', subagents }), 'awaiting-approval');
    assert.strictEqual(displayStatus({ status: 'error', subagents }), 'error');
  });
});

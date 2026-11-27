import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { initialChoice, moveDialogView, moveMessage, reduceMove } from '../../client-core/sync/move-dialog';
import type { MovePanel } from '../../protocol/messages';
import { initialHistoryState, reduceHistory } from '../../history/reducer';
import { initialState, reduce } from '../../client-core/reducer';

const at = (h: number, m: number) => new Date(2026, 10, 27, h, m).getTime();
const panel = (over: Partial<MovePanel> = {}): MovePanel => ({
  id: 'r1', mode: 'move', checkouts: [
    { root: '/w/repo', branch: 'main', main: true },
    { root: '/w/repo/.worktrees/feat-x', branch: 'feat/x', main: false },
  ], defaultRoot: '/w/repo', branch: 'main', thread: 'restored', ownerName: 'PC-desk', lastSeenAt: at(14, 32), ...over,
});
const view = (p: MovePanel, extra: Partial<Parameters<typeof moveDialogView>[0]> = {}) =>
  moveDialogView({ panel: p, choice: initialChoice(p), name: 'fixer', running: false, now: at(18, 0), ...extra });

suite('move dialog view', () => {
  test('a move names the session, lists checkouts by folder and branch, and says the thread comes along', () => {
    const v = view(panel());
    assert.strictEqual(v.title, 'Move "fixer" here');
    assert.deepStrictEqual(v.lines, ['The agent thread comes along.']);
    assert.deepStrictEqual(v.options.map((o) => [o.label, o.detail]), [['repo · main', '/w/repo'], ['feat-x · feat/x', '/w/repo/.worktrees/feat-x']]);
    assert.strictEqual(v.selected, 'root:/w/repo');
    assert.deepStrictEqual(v.action, { label: 'Move here', disabled: false, kind: 'move' });
    assert.strictEqual(v.checkbox, undefined);
  });

  test('a running session offers to stop its turn on the owner', () => {
    assert.strictEqual(view(panel(), { running: true }).checkbox, 'Stop the running turn on PC-desk');
  });

  test('no checkout on the branch offers a new worktree, chosen by default', () => {
    const p = panel({ branch: 'feat/y', defaultRoot: undefined, thread: 'restarted' });
    const v = view(p);
    assert.strictEqual(v.options.at(-1)?.label, 'New worktree for feat/y');
    assert.strictEqual(v.selected, 'worktree:feat/y');
    assert.deepStrictEqual(v.lines, ['The agent restarts from the transcript; earlier tool output is not in its context.']);
    assert.deepStrictEqual(initialChoice(p), { createWorktree: 'feat/y', cancelTurn: false });
  });

  test('a take over says when the owner was last seen and what is lost', () => {
    const v = view(panel({ mode: 'take-over' }));
    assert.strictEqual(v.title, 'Take over "fixer"');
    assert.strictEqual(v.lines[1], "PC-desk was last seen 14:32. A turn it was running is lost, and code it didn't push isn't here.");
    assert.deepStrictEqual(v.action, { label: 'Take over', disabled: false, kind: 'take-over' });
    const older = view(panel({ mode: 'take-over', lastSeenAt: new Date(2026, 10, 25, 9, 5).getTime() }));
    assert.strictEqual(older.lines[1].startsWith('PC-desk was last seen 2026-11-25 09:05.'), true);
  });

  test('an unavailable move shows only its reason and Close', () => {
    const v = view(panel({ mode: 'unavailable', reason: 'PC-desk is offline.' }));
    assert.deepStrictEqual([v.title, v.lines, v.options.length, v.action.kind], ['Can\'t move "fixer"', ['PC-desk is offline.'], 0, 'close']);
  });

  test('progress replaces the action, and a failure shows the reason', () => {
    const p = panel();
    const steps = { reply: 'Waiting for PC-desk to hand it over…', transcript: 'Copying the transcript…', thread: 'Restoring the agent…', claim: 'Claiming the session…' } as const;
    for (const [step, text] of Object.entries(steps)) {
      const v = view(p, { status: { state: 'waiting', step: step as keyof typeof steps } });
      assert.deepStrictEqual([v.progress, v.action], [text, { label: 'Moving…', disabled: true, kind: 'move' }]);
    }
    assert.strictEqual(view(p, { status: { state: 'failed', reason: 'nope' } }).error, 'nope');
  });

  test('the message follows the choice, and unavailable sends nothing', () => {
    assert.deepStrictEqual(moveMessage(panel(), { root: '/w/repo', cancelTurn: true }), { t: 'move-session', id: 'r1', target: { root: '/w/repo' }, cancelTurn: true });
    assert.deepStrictEqual(moveMessage(panel({ mode: 'take-over' }), { createWorktree: 'feat/x', cancelTurn: false }), { t: 'take-over-session', id: 'r1', target: { createWorktree: 'feat/x' } });
    assert.strictEqual(moveMessage(panel({ mode: 'unavailable' }), { root: '/w', cancelTurn: false }), undefined);
  });

  test('statuses for another session are ignored, and a new attempt clears the old failure', () => {
    let slice = reduceMove(undefined, { t: 'move-panel', panel: panel() });
    slice = reduceMove(slice, { t: 'move-status', id: 'other', status: { state: 'failed', reason: 'x' } });
    assert.strictEqual(slice?.status, undefined);
    slice = reduceMove(slice, { t: 'move-status', id: 'r1', status: { state: 'failed', reason: 'busy' } });
    slice = reduceMove(slice, { t: 'move-status', id: 'r1', status: { state: 'waiting', step: 'reply' } });
    assert.deepStrictEqual(slice?.status, { state: 'waiting', step: 'reply' });
    assert.strictEqual(reduceMove(slice, { t: 'move-panel', panel: panel({ id: 'r2' }) })?.status, undefined);
  });

  test('both clients keep the dialog slice from genuine host messages', () => {
    const msgs = [{ t: 'move-panel', panel: panel() }, { t: 'move-status', id: 'r1', status: { state: 'waiting', step: 'claim' } }] as const;
    const history = msgs.reduce((s, m) => reduceHistory(s, m), initialHistoryState);
    const client = msgs.reduce((s, m) => reduce(s, m), initialState);
    assert.deepStrictEqual(history.move?.status, { state: 'waiting', step: 'claim' });
    assert.deepStrictEqual(client.move?.status, { state: 'waiting', step: 'claim' });
  });

  test('reopening the dialog mid-move keeps it in progress; after a failure it starts clean', () => {
    let slice = reduceMove(undefined, { t: 'move-panel', panel: panel() });
    slice = reduceMove(slice, { t: 'move-status', id: 'r1', status: { state: 'waiting', step: 'transcript' } });
    slice = reduceMove(slice, { t: 'move-panel', panel: panel() });
    assert.deepStrictEqual(slice?.status, { state: 'waiting', step: 'transcript' });
    slice = reduceMove(slice, { t: 'move-status', id: 'r1', status: { state: 'failed', reason: 'x' } });
    assert.strictEqual(reduceMove(slice, { t: 'move-panel', panel: panel() })?.status, undefined);
  });
});

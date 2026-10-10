import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { buildWorkerPreamble } from '../../host/self-control/worker-preamble';

const base = {
  lead: 'lead-1',
  self: { name: 'w-a', task: 'write the parser' },
  siblings: [{ name: 'w-b', task: 'write the tests' }],
  commit: true,
};

suite('buildWorkerPreamble', () => {
  test('names the lead and siblings and ends with the task', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('lead-1'), true);
    assert.strictEqual(text.includes('w-b: write the tests'), true);
    assert.strictEqual(text.trimEnd().endsWith('write the parser'), true);
  });

  test('never mentions a session outside the team', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('bystander'), false);
    assert.strictEqual(text.includes('list_sessions'), false);
  });

  test('commit rules appear when commit is true and carry the path-limited form', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('git commit -m'), true);
    assert.strictEqual(text.includes('-- <your paths>'), true);
    assert.strictEqual(text.includes('git add -A'), true);
    assert.strictEqual(text.includes('Do not push'), true);
  });

  test('commit false tells the worker to leave changes uncommitted', () => {
    const text = buildWorkerPreamble({ ...base, commit: false });
    assert.strictEqual(text.includes('git commit -m'), false);
    assert.strictEqual(text.includes('Do not commit'), true);
  });

  test('scope is quoted only when given', () => {
    assert.strictEqual(buildWorkerPreamble(base).includes('Your scope'), false);
    const text = buildWorkerPreamble({ ...base, scope: 'src/parser/' });
    assert.strictEqual(text.includes('Your scope: src/parser/'), true);
  });

  test('tells workers to coordinate shared things with teammates directly, and the lead only for results', () => {
    const text = buildWorkerPreamble(base);
    assert.strictEqual(text.includes('Message them directly with marcode__send_message'), true);
    assert.strictEqual(text.includes('Message the lead only for results, blockers'), true);
  });

  test('a lone worker is not told to coordinate with teammates', () => {
    const text = buildWorkerPreamble({ ...base, siblings: [] });
    assert.strictEqual(text.includes('Message them directly'), false);
  });

  test('the team brief is passed on when given and absent otherwise', () => {
    assert.strictEqual(buildWorkerPreamble(base).includes('Team brief'), false);
    const text = buildWorkerPreamble({ ...base, brief: 'One shared emulator: take turns.' });
    assert.strictEqual(text.includes('Team brief: One shared emulator: take turns.'), true);
  });

  test('a lone worker has no sibling line', () => {
    const text = buildWorkerPreamble({ ...base, siblings: [] });
    assert.strictEqual(text.includes('siblings'), false);
  });
});

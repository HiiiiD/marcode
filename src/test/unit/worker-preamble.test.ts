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

  test('a lone worker has no sibling line', () => {
    const text = buildWorkerPreamble({ ...base, siblings: [] });
    assert.strictEqual(text.includes('siblings'), false);
  });
});

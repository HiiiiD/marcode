import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { fuzzyScore, jaroWinkler, rankByQuery } from '../../shared/fuzzy-score';

suite('fuzzy-score', () => {
  test('jaroWinkler: identical is 1, disjoint is 0', () => {
    assert.strictEqual(jaroWinkler('sonnet', 'sonnet'), 1);
    assert.strictEqual(jaroWinkler('abc', 'xyz'), 0);
  });

  test('jaroWinkler: known reference value', () => {
    assert.strictEqual(Math.abs(jaroWinkler('martha', 'marhta') - 0.9611) < 0.001, true);
  });

  test('fuzzyScore: exact match after normalization is 1', () => {
    assert.strictEqual(fuzzyScore('Claude Sonnet 5', 'claude-sonnet-5'), 1);
  });

  test('fuzzyScore: token subset beats an unrelated string', () => {
    const hit = fuzzyScore('sonnet 5', 'claude-sonnet-5');
    const miss = fuzzyScore('sonnet 5', 'gpt-4o-mini');
    assert.strictEqual(hit >= 0.9 && hit < 1, true);
    assert.strictEqual(miss < 0.8, true);
  });

  test('fuzzyScore: typo still scores high', () => {
    assert.strictEqual(fuzzyScore('sonet', 'sonnet') > 0.9, true);
  });

  test('rankByQuery: best first, drops below threshold, keeps the best field per item', () => {
    const items = [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', name: 'Claude Opus 5' },
    ];
    const out = rankByQuery('sonnet', items, (m) => [m.id, m.name]);
    assert.strictEqual(out[0].item.id, 'claude-sonnet-5');
    assert.strictEqual(out.some((r) => r.item.id === 'gpt-4o-mini'), false);
    assert.strictEqual(out.every((r, i) => i === 0 || out[i - 1].score >= r.score), true);
  });
});

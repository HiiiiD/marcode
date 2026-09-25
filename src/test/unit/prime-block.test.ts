import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { buildMemoryBlock, queryTermsOf } from '../../memory/prime-block';
import type { MemoryHit } from '../../memory/types';

const hit = (over: Partial<MemoryHit> = {}): MemoryHit => ({
  sessionId: 's1', itemId: 'u1', snippet: 'fix flaky login test → patched retry · 2 files edited',
  score: 5, ts: 0, ...over,
});

suite('queryTermsOf', () => {
  test('drops stopwords and short words, lowercases, dedupes', () => {
    assert.deepStrictEqual(queryTermsOf('Fix the flaky login test, fix it now'), ['flaky', 'login', 'test']);
  });

  test('caps the term count', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}xx`).join(' ');
    assert.strictEqual(queryTermsOf(text).length <= 12, true);
  });

  test('returns nothing for a prompt with no usable words', () => {
    assert.deepStrictEqual(queryTermsOf('ok do it'), []);
  });
});

suite('buildMemoryBlock', () => {
  test('returns undefined when no hit clears the score floor', () => {
    assert.strictEqual(buildMemoryBlock([hit({ score: 0.01 })]), undefined);
    assert.strictEqual(buildMemoryBlock([]), undefined);
  });

  test('lists hits with the ids recall_fetch needs, capped at three', () => {
    const hits = [1, 2, 3, 4].map((n) => hit({ sessionId: `s${n}`, itemId: `u${n}` }));
    const block = buildMemoryBlock(hits) as string;
    assert.strictEqual(block.startsWith('<marcode-memory>'), true);
    assert.strictEqual(block.endsWith('</marcode-memory>'), true);
    assert.strictEqual(block.includes('sessionId=s3'), true);
    assert.strictEqual(block.includes('itemId'), false);
    assert.strictEqual(block.includes('s4'), false);
    assert.strictEqual(block.includes('marcode__recall_fetch'), true);
  });
});

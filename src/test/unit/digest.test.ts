import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { digestText, extractiveDigest, indexLine, SUMMARIZER_VERSION } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });
const assistant = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });

suite('extractiveDigest', () => {
  test('takes the first user text as title and request, the last assistant text as outcome', () => {
    const d = extractiveDigest([
      user('u1', 'Fix the flaky login test'), assistant('a1', 'Looking'), assistant('a2', 'Added a retry'),
    ], 42)!;
    assert.strictEqual(d.title, 'Fix the flaky login test');
    assert.strictEqual(d.request, 'Fix the flaky login test');
    assert.strictEqual(d.outcome, 'Added a retry');
    assert.strictEqual(d.source, 'extractive');
    assert.strictEqual(d.summarizerVersion, SUMMARIZER_VERSION);
    assert.strictEqual(d.forUpdatedAt, 42);
  });

  test('returns undefined when there is no user text', () => {
    assert.strictEqual(extractiveDigest([assistant('a1', 'hi')], 1), undefined);
    assert.strictEqual(extractiveDigest([], 1), undefined);
  });

  test('clips a long request and outcome', () => {
    const d = extractiveDigest([user('u1', 'x'.repeat(500)), assistant('a1', 'y'.repeat(500))], 1)!;
    assert.strictEqual(d.title.length <= 161, true);
    assert.strictEqual(d.outcome.length <= 201, true);
  });
});

suite('indexLine and digestText', () => {
  test('indexLine joins title and outcome and counts edited files', () => {
    const d = extractiveDigest([user('u1', 'Fix it'), assistant('a1', 'Done')], 1)!;
    d.filesEdited = ['a.ts', 'b.ts'];
    assert.strictEqual(indexLine(d), 'Fix it → Done · 2 files edited');
  });

  test('indexLine omits the outcome and files when absent', () => {
    const d = extractiveDigest([user('u1', 'Just asking')], 1)!;
    assert.strictEqual(indexLine(d), 'Just asking');
  });

  test('digestText renders llm-only fields when present', () => {
    const d = extractiveDigest([user('u1', 'Fix it'), assistant('a1', 'Done')], 1)!;
    d.learned = 'The cache key ignored cwd';
    d.decisions = ['Key on cwd'];
    d.nextSteps = ['Add a test'];
    const text = digestText(d);
    assert.strictEqual(text.includes('Learned: The cache key ignored cwd'), true);
    assert.strictEqual(text.includes('- Key on cwd'), true);
    assert.strictEqual(text.includes('- Add a test'), true);
  });
});

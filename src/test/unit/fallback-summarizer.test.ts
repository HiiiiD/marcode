import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { extractiveDigest } from '../../memory/digest';
import { FallbackSummarizer } from '../../host/digest/fallback-summarizer';
import type { SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

const items: TranscriptItem[] = [{ id: 'u1', ts: 0, role: 'user', text: 'Fix login' }];
const base = () => extractiveDigest(items, 9)!;

const ok = (title: string, calls: string[]) => ({
  async summarize(_i: TranscriptItem[], b: SessionDigest): Promise<SessionDigest> { calls.push(title); return { ...b, title }; },
});
const failing = (message: string, calls: string[]) => ({
  async summarize(): Promise<SessionDigest> { calls.push(message); throw new Error(message); },
});

suite('FallbackSummarizer', () => {
  test('uses the primary and never calls a fallback when it succeeds', async () => {
    const calls: string[] = [];
    const s = new FallbackSummarizer([ok('primary', calls), ok('second', calls)]);
    assert.strictEqual((await s.summarize(items, base())).title, 'primary');
    assert.deepStrictEqual(calls, ['primary']);
  });

  test('moves to the next summarizer when the primary throws', async () => {
    const calls: string[] = [];
    const s = new FallbackSummarizer([failing('limit', calls), ok('second', calls)]);
    assert.strictEqual((await s.summarize(items, base())).title, 'second');
    assert.deepStrictEqual(calls, ['limit', 'second']);
  });

  test('tries the primary again on every call', async () => {
    const calls: string[] = [];
    const s = new FallbackSummarizer([failing('limit', calls), ok('second', calls)]);
    await s.summarize(items, base());
    await s.summarize(items, base());
    assert.deepStrictEqual(calls, ['limit', 'second', 'limit', 'second']);
  });

  test('rethrows the last error when every summarizer fails', async () => {
    const calls: string[] = [];
    const s = new FallbackSummarizer([failing('one', calls), failing('two', calls)]);
    await assert.rejects(() => s.summarize(items, base()), /two/);
    assert.deepStrictEqual(calls, ['one', 'two']);
  });

  test('takes concurrency from the primary', () => {
    const s = new FallbackSummarizer([{ ...ok('a', []), concurrency: 5 }, { ...ok('b', []), concurrency: 1 }]);
    assert.strictEqual(s.concurrency, 5);
  });
});

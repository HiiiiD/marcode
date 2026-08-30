import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { ExtractiveSummarizer } from '../../memory/extractive-summarizer';
import type { TranscriptItem } from '../../protocol/messages';

function userItem(text: string): TranscriptItem {
  return { id: 'u1', ts: 0, role: 'user', text };
}
function assistantItem(text: string): TranscriptItem {
  return { id: 'a1', ts: 1, role: 'assistant', text };
}

suite('ExtractiveSummarizer', () => {
  test('summarizes from the first user message and the item count', async () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = await summarizer.summarize([
      userItem('Fix the flaky login test'),
      assistantItem('Looking into it'),
      userItem('Any luck?'),
    ]);
    assert.strictEqual(summary, 'Fix the flaky login test (3 messages)');
  });

  test('truncates a long first message to 200 characters', async () => {
    const summarizer = new ExtractiveSummarizer();
    const long = 'x'.repeat(250);
    const summary = await summarizer.summarize([userItem(long)]);
    assert.strictEqual(summary, `${'x'.repeat(200)}… (1 message)`);
  });

  test('falls back to a fixed label when there is no user message', async () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = await summarizer.summarize([assistantItem('hello')]);
    assert.strictEqual(summary, 'Untitled session (1 message)');
  });

  test('handles an empty transcript', async () => {
    const summarizer = new ExtractiveSummarizer();
    const summary = await summarizer.summarize([]);
    assert.strictEqual(summary, 'Untitled session (0 messages)');
  });
});

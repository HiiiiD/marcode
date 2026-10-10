import * as assert from 'assert';
import { buildSummaryPrompt } from '../../host/digest/llm-prompt';
import { digestText, extractiveDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

const items: TranscriptItem[] = [
  { id: 'u1', ts: 1, role: 'user', text: 'please add a login form' },
  { id: 'sh1', ts: 2, role: 'shell', command: 'cat .env', state: 'done', output: 'API_KEY=hunter2', exitCode: 0 },
  { id: 'a1', ts: 3, role: 'assistant', text: 'Added the login form.' },
];

suite('shell commands stay out of every model-bound path', () => {
  test('the LLM summarizer prompt never contains them', () => {
    const prompt = buildSummaryPrompt(items);
    assert.strictEqual(prompt.includes('hunter2') || prompt.includes('cat .env'), false);
    assert.strictEqual(prompt.includes('login form'), true);
  });
  test('the extractive digest never contains them', () => {
    const digest = extractiveDigest(items, 3);
    assert.strictEqual(digest !== undefined, true);
    const text = digestText(digest!);
    assert.strictEqual(text.includes('hunter2') || text.includes('cat .env'), false);
  });
});

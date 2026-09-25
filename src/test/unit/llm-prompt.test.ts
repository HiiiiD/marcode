import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { extractiveDigest } from '../../memory/digest';
import { buildSummaryPrompt, parseLlmDigest } from '../../host/digest/llm-prompt';
import type { TranscriptItem } from '../../protocol/messages';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'user', text });
const assistant = (id: string, text: string): TranscriptItem => ({ id, ts: 0, role: 'assistant', text });
const base = () => extractiveDigest([user('u1', 'Fix login'), assistant('a1', 'Done')], 7)!;

suite('buildSummaryPrompt', () => {
  test('keeps user prompts and each turn\'s last assistant text, and drops earlier assistant chatter', () => {
    const prompt = buildSummaryPrompt([
      user('u1', 'Fix login'), assistant('a1', 'Looking at it'), assistant('a2', 'Added a retry'),
      user('u2', 'Thanks'), assistant('a3', 'Welcome'),
    ]);
    assert.strictEqual(prompt.includes('USER: Fix login'), true);
    assert.strictEqual(prompt.includes('ASSISTANT: Added a retry'), true);
    assert.strictEqual(prompt.includes('Looking at it'), false);
  });

  test('caps the conversation and marks the omitted middle', () => {
    const items: TranscriptItem[] = [];
    for (let i = 0; i < 200; i++) { items.push(user(`u${i}`, 'q'.repeat(500)), assistant(`a${i}`, 'r'.repeat(500))); }
    const prompt = buildSummaryPrompt(items);
    assert.strictEqual(prompt.length < 20_000, true);
    assert.strictEqual(prompt.includes('middle omitted'), true);
  });

  test('tells the model to answer with one JSON object and use no tools', () => {
    const prompt = buildSummaryPrompt([user('u1', 'hi')]);
    assert.strictEqual(prompt.includes('ONE JSON object'), true);
    assert.strictEqual(prompt.includes('Do not use any tools'), true);
  });
});

suite('parseLlmDigest', () => {
  const reply = JSON.stringify({
    title: 'Login retry', request: 'Fix login', outcome: 'Added a retry',
    learned: 'Fixture raced', decisions: ['Retry twice'], nextSteps: [],
  });

  test('parses a bare JSON object into an llm digest that keeps the base identity', () => {
    const d = parseLlmDigest(reply, base());
    assert.strictEqual(d.source, 'llm');
    assert.strictEqual(d.title, 'Login retry');
    assert.strictEqual(d.forUpdatedAt, 7);
    assert.deepStrictEqual(d.decisions, ['Retry twice']);
    assert.strictEqual(d.learned, 'Fixture raced');
  });

  test('parses JSON wrapped in a markdown fence and prose', () => {
    const d = parseLlmDigest(`Here you go:\n\`\`\`json\n${reply}\n\`\`\`\nHope that helps.`, base());
    assert.strictEqual(d.outcome, 'Added a retry');
  });

  test('throws on a reply with no JSON object', () => {
    assert.throws(() => parseLlmDigest('I could not summarize this.', base()), /no JSON object/);
  });

  test('throws when title or outcome is missing', () => {
    assert.throws(() => parseLlmDigest('{"title":"x"}', base()), /missing title or outcome/);
  });

  test('clips an overlong title', () => {
    const d = parseLlmDigest(JSON.stringify({ title: 't'.repeat(300), outcome: 'o' }), base());
    assert.strictEqual(d.title.length <= 81, true);
  });
});

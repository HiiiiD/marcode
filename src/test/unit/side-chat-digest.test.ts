import * as assert from 'assert';
import type { TranscriptItem } from '../../protocol/messages';
import { buildSideChatDigest, SIDE_CHAT_HEADER } from '../../host/side-chat-digest';

const user = (id: string, text: string): TranscriptItem => ({ id, ts: 1, role: 'user', text });
const assistant = (id: string, text: string): TranscriptItem =>
  ({ id, ts: 1, role: 'assistant', text, state: 'done' } as TranscriptItem);
const error = (id: string): TranscriptItem => ({ id, ts: 1, role: 'error', message: 'boom' });

suite('buildSideChatDigest', () => {
  const copied = [user('c1', 'copied question'), assistant('c2', 'copied answer')];

  test('starts with the header and holds only what came after the fork', () => {
    const digest = buildSideChatDigest([...copied, user('s1', 'why a clamp?'), assistant('s2', 'because of overflow')], 2);

    assert.strictEqual(digest.startsWith(SIDE_CHAT_HEADER), true);
    assert.strictEqual(digest.includes('USER: why a clamp?'), true);
    assert.strictEqual(digest.includes('ASSISTANT: because of overflow'), true);
    assert.strictEqual(digest.includes('copied'), false);
  });

  test('leaves out errors', () => {
    const digest = buildSideChatDigest([...copied, user('s1', 'q'), error('s2'), assistant('s3', 'a')], 2);

    assert.strictEqual(digest.includes('boom'), false);
  });

  test('drops the oldest lines to stay within the budget and says so', () => {
    const items = [user('s1', 'first-question'), assistant('s2', 'x'.repeat(200)), user('s3', 'last-question')];

    const digest = buildSideChatDigest(items, 0, SIDE_CHAT_HEADER.length + 120);

    assert.strictEqual(digest.includes('last-question'), true);
    assert.strictEqual(digest.includes('first-question'), false);
    assert.strictEqual(digest.includes('omitted'), true);
    assert.strictEqual(digest.length <= SIDE_CHAT_HEADER.length + 120, true);
  });

  test('nothing after the fork is an empty digest', () => {
    assert.strictEqual(buildSideChatDigest(copied, 2), '');
  });
});

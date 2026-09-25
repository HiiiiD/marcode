import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { extractiveDigest } from '../../memory/digest';
import { LlmSummarizer } from '../../host/digest/llm-summarizer';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentEvent } from '../../providers/types';
import type { TranscriptItem } from '../../protocol/messages';

const items: TranscriptItem[] = [
  { id: 'u1', ts: 0, role: 'user', text: 'Fix login' },
  { id: 'a1', ts: 0, role: 'assistant', text: 'Done' },
];
const base = () => extractiveDigest(items, 9)!;
const okReply = JSON.stringify({ title: 'Login', outcome: 'Fixed' });

const summarizer = (script: (text: string) => AgentEvent[], timeoutMs = 2000) => {
  const provider = new FakeProvider(script);
  return { provider, s: new LlmSummarizer({ provider, model: 'fake-small', effort: 'low', cwd: '/tmp', timeoutMs }) };
};

suite('LlmSummarizer', () => {
  test('starts a run without self-control on the configured model and effort, and returns the parsed digest', async () => {
    const { provider, s } = summarizer(() => [
      { kind: 'text', delta: okReply }, { kind: 'turn-end', reason: 'done' },
    ]);
    const digest = await s.summarize(items, base());
    assert.strictEqual(digest.source, 'llm');
    assert.strictEqual(digest.title, 'Login');
    const start = provider.starts[0];
    assert.strictEqual(start.withoutSelfControl, true);
    assert.strictEqual(start.model, 'fake-small');
    assert.strictEqual(start.effort, 'low');
    assert.strictEqual(start.cwd, '/tmp');
  });

  test('sends the built prompt, not the raw transcript', async () => {
    const { provider, s } = summarizer(() => [
      { kind: 'text', delta: okReply }, { kind: 'turn-end', reason: 'done' },
    ]);
    await s.summarize(items, base());
    assert.strictEqual(provider.sent[0].text.includes('<conversation>'), true);
  });

  test('denies a tool permission request and rejects on the resulting empty reply', async () => {
    const { provider, s } = summarizer(() => [{
      kind: 'permission', id: 'p1', tool: { kind: 'command', label: 'Bash', command: 'ls' },
    }]);
    await assert.rejects(() => s.summarize(items, base()));
    assert.deepStrictEqual(provider.decisions.get('p1'), { allow: false, reason: 'The summarizer may not use tools.' });
  });

  test('rejects on an error turn-end', async () => {
    const { s } = summarizer(() => [{ kind: 'turn-end', reason: 'error', error: 'auth failed' }]);
    await assert.rejects(() => s.summarize(items, base()), /auth failed/);
  });

  test('rejects on a timeout', async () => {
    const { s } = summarizer(() => [], 30);
    await assert.rejects(() => s.summarize(items, base()), /timed out/);
  });

  test('rejects when the reply is not usable JSON', async () => {
    const { s } = summarizer(() => [
      { kind: 'text', delta: 'sorry, no' }, { kind: 'turn-end', reason: 'done' },
    ]);
    await assert.rejects(() => s.summarize(items, base()), /no JSON object/);
  });
});

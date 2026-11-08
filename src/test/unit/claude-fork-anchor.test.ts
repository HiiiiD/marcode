import * as assert from 'assert';
import { anchorFor, type AnchorMessage } from '../../providers/claude/fork-anchor';

const prompt = (uuid: string): AnchorMessage => ({
  type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: 'hi' },
});
const toolResult = (uuid: string): AnchorMessage => ({
  type: 'user', uuid, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
});
const assistant = (uuid: string): AnchorMessage => ({
  type: 'assistant', uuid, parent_tool_use_id: null, message: { role: 'assistant', content: [] },
});

suite('anchorFor', () => {
  const messages = [
    prompt('u1'), assistant('a1'), toolResult('r1'), assistant('a2'),
    prompt('u2'), assistant('a3'),
  ];

  test('the first turn ends at the message before the second prompt', () => {
    assert.strictEqual(anchorFor(messages, 0), 'a2');
  });

  test('the last turn ends at the final message', () => {
    assert.strictEqual(anchorFor(messages, 1), 'a3');
  });

  test('a tool result is not a turn boundary', () => {
    assert.strictEqual(anchorFor([prompt('u1'), assistant('a1'), toolResult('r1')], 0), 'r1');
  });

  test('a turn index past the available prompts has no anchor', () => {
    assert.strictEqual(anchorFor(messages, 2), undefined);
  });

  test('a subagent message is not a turn boundary', () => {
    const sub: AnchorMessage = { ...prompt('s1'), parent_tool_use_id: 'task-1' };
    assert.strictEqual(anchorFor([prompt('u1'), sub, assistant('a1')], 0), 'a1');
  });

  test('interrupt markers and tag-only messages are not turn boundaries', () => {
    const text = (uuid: string, t: string): AnchorMessage => ({
      type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: t }] },
    });
    const seq = [
      prompt('u1'), assistant('a1'), text('i1', '[Request interrupted by user]'),
      text('t1', '<local-command-stdout>ok</local-command-stdout>'), prompt('u2'), assistant('a2'),
    ];

    assert.strictEqual(anchorFor(seq, 0), 't1');
    assert.strictEqual(anchorFor(seq, 1), 'a2');
    assert.strictEqual(anchorFor(seq, 2), undefined);
  });
});

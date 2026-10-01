import { act, useState } from 'react';
import { afterEach, expect, test } from 'bun:test';
import type { QuestionRequest } from '../../protocol/messages';
import { QuestionPrompt } from '../../tui/ui/question-prompt';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });
const answers = () => m!.posted.filter((p) => p.t === 'question-answer');

const single: QuestionRequest = {
  requestId: 'r1', blocking: true,
  questions: [{ id: 'scope', header: 'Scope', question: 'Which one?', multiSelect: false, allowOther: false, secret: false,
    options: [{ label: 'Cards only', description: 'small' }, { label: 'Both', description: 'shared' }] }],
};
const multi: QuestionRequest = {
  requestId: 'r2', blocking: true,
  questions: [{ id: 'pick', header: 'Pick', question: 'Which?', multiSelect: true, allowOther: false, secret: false,
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }, { label: 'C', description: '' }] }],
};
const secret: QuestionRequest = {
  requestId: 'r3', blocking: true,
  questions: [{ id: 'key', header: 'Key', question: 'API key?', multiSelect: false, allowOther: false, secret: true }],
};
const two: QuestionRequest = {
  requestId: 'r4', blocking: true,
  questions: [
    { id: 'one', header: 'One', question: 'First?', multiSelect: false, allowOther: false, secret: false,
      options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }] },
    { id: 'two', header: 'Two', question: 'Name?', multiSelect: false, allowOther: false, secret: false },
  ],
};
const other: QuestionRequest = {
  requestId: 'r5', blocking: true,
  questions: [{ id: 'o', header: 'O', question: 'Pick or say?', multiSelect: false, allowOther: true, secret: false,
    options: [{ label: 'Yes', description: '' }] }],
};

test('single select: Down then Enter answers with the second label, once', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={single} focused />);
  expect(m.frame()).toContain('Which one?');
  await m.press('down');
  await m.press('return');
  await m.press('return');
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r1', answers: { scope: ['Both'] } }]);
});

test('multi select: Space toggles and Enter submits the chosen set', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={multi} focused />);
  await m.press('space');
  await m.press('down');
  await m.press('down');
  await m.press('space');
  await m.press('return');
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r2', answers: { pick: ['A', 'C'] } }]);
});

test('a secret answer is masked on screen but sent verbatim', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={secret} focused />);
  await m.type('Hunter 2');
  expect(m.frame()).not.toContain('Hunter');
  expect(m.frame()).toContain('●●●●●●●●');
  await m.press('return');
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r3', answers: { key: ['Hunter 2'] } }]);
});

test('a two-question request posts one answer with both keys after the last', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={two} focused />);
  await m.press('down');
  await m.press('return');
  expect(answers().length).toBe(0);
  expect(m.frame()).toContain('Name?');
  await m.type('Ada Lovelace');
  await m.press('return');
  expect(answers()).toEqual([
    { t: 'question-answer', id: 's1', requestId: 'r4', answers: { one: ['Y'], two: ['Ada Lovelace'] } },
  ]);
});

test('allowOther: picking Other opens free text and answers with it', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={other} focused />);
  expect(m.frame()).toContain('Other');
  await m.press('down');
  await m.press('return');
  await m.type('Maybe yn');
  await m.press('return');
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r5', answers: { o: ['Maybe yn'] } }]);
});

test('an unfocused question ignores keys', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={single} focused={false} />);
  await m.press('return');
  expect(answers().length).toBe(0);
});

const multiOther: QuestionRequest = {
  requestId: 'r6', blocking: true,
  questions: [{ id: 'm', header: 'M', question: 'Pick some?', multiSelect: true, allowOther: true, secret: false,
    options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
};

test('multi select with Other: the typed text joins the chosen set', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={multiOther} focused />);
  await m.press('space');
  await m.press('down');
  await m.press('down');
  await m.press('space');
  await m.type('Zed');
  await m.press('return');
  await m.press('return');
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r6', answers: { m: ['A', 'Zed'] } }]);
});

test('down and Enter in one batch answer the moved option', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={single} focused />);
  await m.pressMany(['down', 'return']);
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r1', answers: { scope: ['Both'] } }]);
});

test('typed text and Enter in one batch answer with the full text', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={secret} focused />);
  await m.pressMany(['a', 'b', 'c', 'return']);
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r3', answers: { key: ['abc'] } }]);
});

test('Other, typed text and Enter in one batch answer with the text', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={other} focused />);
  await m.pressMany(['down', 'return', 'h', 'i', 'return']);
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r5', answers: { o: ['hi'] } }]);
});

test('multi toggles and submit in one batch send the chosen set', async () => {
  m = await mount(<QuestionPrompt sessionId="s1" request={multi} focused />);
  await m.pressMany(['space', 'down', 'down', 'space', 'return', 'return']);
  expect(answers()).toEqual([{ t: 'question-answer', id: 's1', requestId: 'r2', answers: { pick: ['A', 'C'] } }]);
});

test('a new request id in the same mount can be answered, once', async () => {
  let swap!: (r: QuestionRequest) => void;
  const Host = () => {
    const [r, setR] = useState(single);
    swap = setR;
    return <QuestionPrompt sessionId="s1" request={r} focused />;
  };
  m = await mount(<Host />);
  await m.press('return');
  await act(async () => { swap({ ...single, requestId: 'r9' }); });
  await m.pressMany(['return', 'return']);
  expect(answers().map((a) => (a as { requestId: string }).requestId)).toEqual(['r1', 'r9']);
});

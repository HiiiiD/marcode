import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import type { QuestionRequest, SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { editText } from './key-text';
import { useTuiStore } from './store';

export function QuestionPrompt(props: { sessionId: SessionId; request: QuestionRequest; focused: boolean }) {
  const { post } = useTuiStore();
  const specs = props.request.questions;
  const [qi, setQi] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const answers = useRef<Record<string, string[]>>({});
  const sent = useRef(false);
  const spec = specs[qi];
  const options = spec?.options ?? [];
  const otherIdx = spec?.allowOther && options.length > 0 ? options.length : -1;
  const rows = otherIdx >= 0 ? [...options.map((o) => o.label), 'Other…'] : options.map((o) => o.label);
  const freeText = options.length === 0 || typing;

  const finishQuestion = (value: string[]) => {
    if (sent.current) { return; }
    answers.current[spec.id] = value;
    if (qi < specs.length - 1) {
      setQi(qi + 1); setCursor(0); setPicked(new Set()); setText(''); setTyping(false);
      return;
    }
    sent.current = true;
    post({ t: 'question-answer', id: props.sessionId, requestId: props.request.requestId, answers: answers.current });
  };

  const chosen = () => [...picked].sort((a, b) => a - b).map((i) => (i === otherIdx ? text : options[i].label));

  useKeyboard((key) => {
    if (!props.focused || !spec) { return; }
    if (freeText) {
      if (key.name === 'return') {
        if (options.length > 0 && spec.multiSelect) {
          setTyping(false);
          setPicked((s) => { const n = new Set(s); if (text) { n.add(otherIdx); } else { n.delete(otherIdx); } return n; });
        } else { finishQuestion([text]); }
      } else if (key.name === 'escape' && options.length > 0) { setTyping(false); }
      else { setText((x) => editText(x, key) ?? x); }
      return;
    }
    const action = actionFor('question', key, { running: false });
    if (action?.do === 'option-next') { setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (action?.do === 'option-prev') { setCursor((c) => Math.max(c - 1, 0)); }
    else if (action?.do === 'option-toggle') {
      if (cursor === otherIdx) { setTyping(true); }
      else if (spec.multiSelect) {
        setPicked((s) => { const n = new Set(s); if (n.has(cursor)) { n.delete(cursor); } else { n.add(cursor); } return n; });
      } else { finishQuestion([options[cursor].label]); }
    }
    else if (action?.do === 'submit-answers') {
      if (spec.multiSelect) { finishQuestion(chosen()); }
      else if (cursor === otherIdx) { setTyping(true); }
      else { finishQuestion([options[cursor].label]); }
    }
  });

  if (!spec) { return <text fg="gray">No question.</text>; }
  const shownText = spec.secret ? '●'.repeat([...text].length) : text;
  const hint = freeText ? 'Enter submit' : spec.multiSelect ? 'Space toggle, Enter submit' : 'Up/Down, Enter choose';
  return (
    <box flexDirection="column" border borderStyle="single" title={spec.header}>
      <text>{spec.question}</text>
      {options.length > 0 && !typing ? rows.map((label, i) => {
        const desc = options[i]?.description;
        const mark = spec.multiSelect ? (picked.has(i) ? '[x] ' : '[ ] ') : '';
        return <text key={label} attributes={i === cursor ? 1 : 0}>{`${i === cursor ? '›' : ' '} ${mark}${label}${desc ? ` — ${desc}` : ''}`}</text>;
      }) : null}
      {freeText ? <text>{`> ${shownText}`}</text> : null}
      <text fg="gray">{typing ? 'Enter confirm, Esc back' : hint}</text>
    </box>
  );
}

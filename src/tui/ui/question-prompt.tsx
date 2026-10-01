import { useKeyboard } from '@opentui/react';
import { useEffect, useRef } from 'react';
import type { QuestionRequest, SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { editText } from './key-text';
import { useTuiStore } from './store';
import { useSyncState } from './use-sync-state';

const fresh = { qi: 0, cursor: 0, picked: [] as number[], text: '', typing: false };

export function QuestionPrompt(props: { sessionId: SessionId; request: QuestionRequest; focused: boolean }) {
  const { post } = useTuiStore();
  const { request } = props;
  const specs = request.questions;
  const st = useSyncState(fresh);
  const answers = useRef<Record<string, string[]>>({});
  const sent = useRef<string | null>(null);

  useEffect(() => { answers.current = {}; st.set(fresh); }, [request.requestId]);

  const specAt = (qi: number) => specs[qi];
  const layout = (qi: number) => {
    const spec = specAt(qi);
    const options = spec?.options ?? [];
    const otherIdx = spec?.allowOther && options.length > 0 ? options.length : -1;
    const rows = otherIdx >= 0 ? [...options.map((o) => o.label), 'Other…'] : options.map((o) => o.label);
    return { spec, options, otherIdx, rows };
  };

  const finishQuestion = (value: string[]) => {
    const { qi } = st.get();
    const { spec } = layout(qi);
    if (sent.current === request.requestId) { return; }
    answers.current[spec.id] = value;
    if (qi < specs.length - 1) { st.set({ qi: qi + 1, cursor: 0, picked: [], text: '', typing: false }); return; }
    sent.current = request.requestId;
    post({ t: 'question-answer', id: props.sessionId, requestId: request.requestId, answers: answers.current });
  };

  useKeyboard((key) => {
    const cur = st.get();
    const { spec, options, otherIdx, rows } = layout(cur.qi);
    if (!props.focused || !spec) { return; }
    if (options.length === 0 || cur.typing) {
      if (key.name === 'return') {
        if (options.length > 0 && spec.multiSelect) {
          const rest = cur.picked.filter((i) => i !== otherIdx);
          st.set({ typing: false, picked: cur.text ? [...rest, otherIdx] : rest });
        } else { finishQuestion([cur.text]); }
      } else if (key.name === 'escape' && options.length > 0) { st.set({ typing: false }); }
      else { st.set({ text: editText(cur.text, key) ?? cur.text }); }
      return;
    }
    const action = actionFor('question', key, { running: false });
    if (action?.do === 'option-next') { st.set({ cursor: Math.min(cur.cursor + 1, rows.length - 1) }); }
    else if (action?.do === 'option-prev') { st.set({ cursor: Math.max(cur.cursor - 1, 0) }); }
    else if (action?.do === 'option-toggle') {
      if (cur.cursor === otherIdx) { st.set({ typing: true }); }
      else if (spec.multiSelect) {
        st.set({ picked: cur.picked.includes(cur.cursor) ? cur.picked.filter((i) => i !== cur.cursor) : [...cur.picked, cur.cursor] });
      } else { finishQuestion([options[cur.cursor].label]); }
    }
    else if (action?.do === 'submit-answers') {
      if (spec.multiSelect) {
        finishQuestion([...cur.picked].sort((a, b) => a - b).map((i) => (i === otherIdx ? cur.text : options[i].label)));
      } else if (cur.cursor === otherIdx) { st.set({ typing: true }); }
      else { finishQuestion([options[cur.cursor].label]); }
    }
  });

  const { qi, cursor, picked, text, typing } = st.view;
  const { spec, options, rows } = layout(qi);
  if (!spec) { return <text fg="gray">No question.</text>; }
  const freeText = options.length === 0 || typing;
  const shownText = spec.secret ? '●'.repeat([...text].length) : text;
  const hint = freeText ? 'Enter submit' : spec.multiSelect ? 'Space toggle, Enter submit' : 'Up/Down, Enter choose';
  return (
    <box flexDirection="column" border borderStyle="single" title={spec.header}>
      <text>{spec.question}</text>
      {options.length > 0 && !typing ? rows.map((label, i) => {
        const desc = options[i]?.description;
        const mark = spec.multiSelect ? (picked.includes(i) ? '[x] ' : '[ ] ') : '';
        return <text key={`${i}:${label}`} attributes={i === cursor ? 1 : 0}>{`${i === cursor ? '›' : ' '} ${mark}${label}${desc ? ` — ${desc}` : ''}`}</text>;
      }) : null}
      {freeText ? <text>{`> ${shownText}`}</text> : null}
      <text fg="gray">{typing ? 'Enter confirm, Esc back' : hint}</text>
    </box>
  );
}

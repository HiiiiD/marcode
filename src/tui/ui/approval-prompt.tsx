import { useKeyboard } from '@opentui/react';
import { useRef, useState } from 'react';
import { clampLines, describeInput, describeTool, type ToolBlock } from '../../client-core/tool-render';
import type { PermissionRequest, SessionId } from '../../protocol/messages';
import { actionFor } from '../keymap';
import { editText } from './key-text';
import { useTuiStore } from './store';

const blockLines = (b: ToolBlock): string[] => {
  switch (b.kind) {
    case 'command': return [`$ ${b.text}`];
    case 'diff': return b.lines;
    case 'lines': case 'json': case 'note': return b.text.split('\n');
    case 'path': return [b.path];
    case 'field': return [`${b.label}: ${b.value}`];
    default: return [];
  }
};

export function ApprovalPrompt(props: { sessionId: SessionId; request: PermissionRequest; focused: boolean }) {
  const { post } = useTuiStore();
  const { request } = props;
  const header = describeTool(request.tool);
  const body = describeInput(request.tool).flatMap(blockLines).join('\n');
  const shown = clampLines(body, 5, 1);
  const [mode, setMode] = useState<'choose' | 'reason'>('choose');
  const [reason, setReason] = useState('');
  const sent = useRef(false);

  const decide = (decision: { allow: true } | { allow: false; reason?: string }) => {
    if (sent.current) { return; }
    sent.current = true;
    post({ t: 'permission-decision', id: props.sessionId, requestId: request.requestId, decision });
  };

  useKeyboard((key) => {
    if (!props.focused) { return; }
    if (mode === 'reason') {
      if (key.name === 'escape') { setMode('choose'); }
      else if (key.name === 'return') { decide(reason.trim() ? { allow: false, reason: reason.trim() } : { allow: false }); }
      else { setReason((x) => editText(x, key) ?? x); }
      return;
    }
    const action = actionFor('approval', key, { running: false });
    if (action?.do === 'allow' || action?.do === 'confirm') { decide({ allow: true }); }
    else if (action?.do === 'deny') { setMode('reason'); }
  });

  const extra = [request.meta?.description, request.meta?.decisionReason].filter((t): t is string => Boolean(t));
  return (
    <box flexDirection="column" border borderStyle="single" title="permission">
      <text fg="yellow">{`${header.verb} ${header.primary}`}</text>
      {extra.map((t, i) => <text key={`m${i}`} fg="gray">{t}</text>)}
      {[...shown.head, ...(shown.hidden > 0 ? [`… ${shown.hidden} more …`] : []), ...shown.tail].map((l, i) => <text key={i}>{l}</text>)}
      {mode === 'choose'
        ? <text>[y] allow  [n] deny</text>
        : <text>{`deny reason (Enter to send, Esc back): ${reason}`}</text>}
    </box>
  );
}

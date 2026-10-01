import type { SessionId } from '../../protocol/messages';
import { bottomSlot } from '../view/bottom-slot';
import { ApprovalPrompt } from './approval-prompt';
import { Composer } from './composer';
import { ForeignBanner } from './foreign-banner';
import { QuestionPrompt } from './question-prompt';
import { useTuiStore } from './store';

export function BottomSlotView({ sessionId, focused }: { sessionId: SessionId; focused: boolean }) {
  const { state } = useTuiStore();
  const pane = state.byId[sessionId];
  const slot = bottomSlot(pane?.summary ?? state.sessions.find((s) => s.id === sessionId), pane);
  switch (slot.kind) {
    case 'question':
      return <QuestionPrompt key={slot.request.requestId} sessionId={sessionId} request={slot.request} focused={focused} />;
    case 'permission':
      return <ApprovalPrompt key={slot.request.requestId} sessionId={sessionId} request={slot.request} focused={focused} />;
    case 'foreign': return <ForeignBanner text={slot.text} />;
    case 'composer': return <Composer sessionId={sessionId} focused={focused} />;
  }
}

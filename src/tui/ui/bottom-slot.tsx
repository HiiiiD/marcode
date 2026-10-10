import type { SessionId } from '../../protocol/messages';
import { bottomSlot } from '../view/bottom-slot';
import type { PickerKind } from '../view/pickers';
import { ApprovalPrompt } from './approval-prompt';
import { Composer } from './composer';
import { ForeignBanner } from './foreign-banner';
import { QuestionPrompt } from './question-prompt';
import { ShellStrip } from './shell-strip';
import { useTuiStore } from './store';

export function BottomSlotView({ sessionId, focused, onOpenPicker }: { sessionId: SessionId; focused: boolean; onOpenPicker?: (kind: PickerKind) => void }) {
  const { state } = useTuiStore();
  const pane = state.byId[sessionId];
  const slot = bottomSlot(pane?.summary ?? state.sessions.find((s) => s.id === sessionId), pane);
  switch (slot.kind) {
    case 'question':
      return <QuestionPrompt key={slot.request.requestId} sessionId={sessionId} request={slot.request} focused={focused} />;
    case 'permission':
      return <ApprovalPrompt key={slot.request.requestId} sessionId={sessionId} request={slot.request} focused={focused} />;
    case 'foreign': return <ForeignBanner text={slot.text} />;
    case 'composer':
      return (
        <box flexDirection="column">
          <ShellStrip sessionId={sessionId} />
          <Composer key={sessionId} sessionId={sessionId} focused={focused} onOpenPicker={onOpenPicker} />
        </box>
      );
  }
}

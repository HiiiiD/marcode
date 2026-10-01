import { ownerReason } from '../../client-core/owner-reason';
import type { PaneState } from '../../client-core/reducer';
import type { PermissionRequest, QuestionRequest, SessionSummary } from '../../protocol/messages';

export type BottomSlot =
  | { kind: 'question'; request: QuestionRequest }
  | { kind: 'permission'; request: PermissionRequest }
  | { kind: 'foreign'; text: string }
  | { kind: 'composer' };

export function bottomSlot(summary: SessionSummary | undefined, pane: PaneState | undefined): BottomSlot {
  const foreign = summary ? ownerReason(summary) : undefined;
  if (summary && !summary.owner && pane) {
    const asks = pane.pendingQuestions;
    const question = asks.find((q) => q.blocking) ?? asks[0];
    if (question) { return { kind: 'question', request: question }; }
    const request = pane.pending[0];
    if (request) { return { kind: 'permission', request }; }
  }
  if (foreign) { return { kind: 'foreign', text: foreign }; }
  return { kind: 'composer' };
}

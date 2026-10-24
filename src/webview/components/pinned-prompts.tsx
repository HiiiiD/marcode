import { useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { subagentLabel } from '../../client-core/subagent-window';
import type { PaneState } from '../../client-core/reducer';
import type { SessionId } from '../../protocol/messages';
import { pendingPrompts } from '../lib/pending-prompts';
import { PermissionCard } from './permission-card';
import { QuestionCard } from './question-card';

export function PinnedPrompts({ pane, sessionId }: { pane: PaneState; sessionId: SessionId }) {
  const entries = pendingPrompts(pane);
  const [selectedId, setSelectedId] = useState<string>();
  if (entries.length === 0) { return null; }
  const index = Math.max(0, entries.findIndex(({ item }) => item.id === selectedId));
  const { parent } = entries[index];
  const total = entries.length;
  return (
    <section aria-label="Pending prompts" className="flex max-h-[50%] min-h-0 flex-col gap-1 border-t border-border px-2 py-1">
      <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {parent ? `Subagent: ${subagentLabel(parent)}` : 'Needs your response'}
        </span>
        {total > 1 && (
          <>
            <Button
              variant="ghost" size="icon-xs" aria-label="Previous prompt"
              disabled={index === 0} onClick={() => setSelectedId(entries[index - 1].item.id)}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span aria-live="polite">{`Prompt ${index + 1} of ${total}`}</span>
            <Button
              variant="ghost" size="icon-xs" aria-label="Next prompt"
              disabled={index === total - 1} onClick={() => setSelectedId(entries[index + 1].item.id)}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </>
        )}
      </div>
      <div className="min-h-0 overflow-y-auto">
        {/* Keep drafts mounted while navigating between unanswered questions. */}
        {entries.map(({ item }, i) => (
          <div key={item.id} hidden={i !== index}>
            {item.role === 'permission'
              ? <PermissionCard item={item} sessionId={sessionId} />
              : <QuestionCard item={item} sessionId={sessionId} />}
          </div>
        ))}
      </div>
    </section>
  );
}

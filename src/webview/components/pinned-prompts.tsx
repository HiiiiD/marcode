import { useEffect, useRef, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { subagentLabel } from '../../client-core/subagent-window';
import type { PaneState } from '../../client-core/reducer';
import type { SessionId } from '../../protocol/messages';
import { pendingPrompts } from '../lib/pending-prompts';
import { usePost } from '../store';
import { PermissionCard } from './permission-card';
import { QuestionCard } from './question-card';

export function PinnedPrompts({ pane, sessionId, fill }: { pane: PaneState; sessionId: SessionId; fill?: boolean }) {
  const post = usePost();
  const entries = pendingPrompts(pane);
  const sent = useRef(new Set<string>());
  useEffect(() => {
    for (const { item } of entries) {
      if (item.role !== 'permission' || item.tool.kind !== 'plan' || sent.current.has(item.requestId)) { continue; }
      sent.current.add(item.requestId);
      post({ t: 'open-plan', requestId: item.requestId, text: item.tool.text, ...(item.tool.path ? { path: item.tool.path } : {}) });
    }
  }, [entries, post]);
  const [selectedId, setSelectedId] = useState<string>();
  if (entries.length === 0) { return null; }
  const index = Math.max(0, entries.findIndex(({ item }) => item.id === selectedId));
  const { parent } = entries[index];
  const total = entries.length;
  return (
    <section aria-label="Pending prompts" className={cn("flex min-h-0 flex-col gap-1 border-t border-border px-2 py-1", fill ? "flex-1" : "max-h-[70%]")}>
      {/* A lone prompt from the main agent already says what it needs; the extra header only repeated it. */}
      {(total > 1 || parent) && <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
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
      </div>}
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

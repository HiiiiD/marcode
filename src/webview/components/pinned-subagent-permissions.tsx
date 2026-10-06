import { useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { pendingSubagentPermissions, subagentLabel } from '../../client-core/subagent-window';
import type { PaneState } from '../../client-core/reducer';
import type { SessionId } from '../../protocol/messages';
import { PermissionCard } from './permission-card';

/**
 * Approvals raised inside a subagent live in its collapsible card, which can
 * be scrolled away or folded. They are mirrored here, above the composer, so
 * a blocked subagent is always answerable without hunting for it.
 */
export function PinnedSubagentPermissions({ pane, sessionId }: { pane: PaneState; sessionId: SessionId }) {
  const live = new Set(pane.pending.map((p) => p.requestId));
  const entries = pendingSubagentPermissions(pane.items).filter((e) => live.has(e.item.requestId));
  const [step, setStep] = useState(0);
  if (entries.length === 0) { return null; }
  const index = Math.min(step, entries.length - 1);
  const { parent, item } = entries[index];
  const total = entries.length;
  return (
    <div role="region" aria-label="Subagent approvals" className="flex shrink-0 flex-col gap-1 border-t border-border px-2 py-1">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">Subagent: {subagentLabel(parent)}</span>
        {total > 1 && (
          <>
            <Button
              variant="ghost" size="icon-xs" aria-label="Previous approval"
              disabled={index === 0} onClick={() => setStep(index - 1)}
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span aria-live="polite">{`${index + 1} of ${total}`}</span>
            <Button
              variant="ghost" size="icon-xs" aria-label="Next approval"
              disabled={index === total - 1} onClick={() => setStep(index + 1)}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </>
        )}
      </div>
      <PermissionCard key={item.id} item={item} sessionId={sessionId} />
    </div>
  );
}

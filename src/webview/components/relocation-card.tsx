import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import { folderName } from '../format';
import type { SessionId, TranscriptItem } from '../../protocol/messages';
import { TranscriptItemShell } from './transcript-item-shell';

type RelocationItem = Extract<TranscriptItem, { role: 'relocation' }>;

/**
 * An offer to follow the agent into a worktree it just created.
 *
 * Unlike a permission request nothing is blocked on the answer, so the card is
 * an invitation rather than an interruption: neutral chrome, not the
 * destructive border a permission prompt wears. An answered offer keeps its
 * place in the transcript as a quiet record of where the work moved.
 */
export function RelocationCard({
  item, sessionId,
}: {
  item: RelocationItem;
  sessionId: SessionId;
}) {
  const { state, post } = useStore();
  const name = folderName(item.path);
  // The host drops a second answer for an already-settled item, and the patch
  // that would settle it here has to round-trip. Without local state both
  // buttons stay live in the meantime and a double-click gets no feedback —
  // the same reasoning as PermissionCard's `answered`.
  const [answered, setAnswered] = useState(false);

  if (item.state !== 'pending') {
    return (
      <TranscriptItemShell role="tool" label="Worktree" ts={item.ts}>
        <div className="text-xs text-muted-foreground" title={item.path}>
          {item.state === 'moved' ? `Moved to ${name}` : 'Stayed'}
        </div>
      </TranscriptItemShell>
    );
  }

  // A turn in flight finishes in the tree it started in, so moving waits for
  // idle. Staying costs nothing and stays live. SessionManager.relocate makes
  // the same check host-side; this only keeps the UI honest about it.
  const status = state.byId[sessionId]?.summary.status;
  const canMove = status === 'idle';

  const answer = (move: boolean) => {
    setAnswered(true);
    post({ t: 'answer-relocation', id: sessionId, itemId: item.id, move });
  };

  return (
    <div className="my-0 rounded border-2 border-border bg-muted/40 p-2 text-xs">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="font-medium">New worktree</span>
        <span className="truncate text-muted-foreground" title={item.path}>{name}</span>
      </div>
      <div className="mb-2 text-muted-foreground">
        Move this session there? Its history stays here.
      </div>
      {/* The disabled button cannot explain itself — the base style sets
          `disabled:pointer-events-none`, so it has no hover and no title. Say
          why in the flow instead. */}
      {!canMove && (
        <div className="mb-2 text-muted-foreground">
          Moving waits for the current turn to finish.
        </div>
      )}
      {/* Stay comes first in DOM and tab order: it is the reversible choice,
          and the offer can be raised again. Move carries the consequence, so
          it is the outlined control rather than solid-primary emphasis —
          matching how PermissionCard refuses to make Allow the loudest thing
          on the card. Neither autofocuses. */}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={answered}
          onClick={() => answer(false)}
          aria-label="Stay in the current directory"
        >
          Stay
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={answered || !canMove}
          onClick={() => answer(true)}
          aria-label={`Move this session to ${name}`}
          title={item.path}
        >
          Move
        </Button>
      </div>
    </div>
  );
}

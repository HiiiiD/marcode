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
  const { post } = useStore();
  const name = folderName(item.path);
  // The host drops a second answer for an already-settled item, and the patch
  // that would settle it here has to round-trip. Without local state both
  // buttons stay live in the meantime and a double-click gets no feedback —
  // the same reasoning as PermissionCard's `answered`.
  //
  // Stored as *the state that was answered*, not a bare boolean: a queued move
  // is answered twice (Move, then possibly Cancel), and a boolean set by the
  // first click would arrive at the queued row with its cancel already dead.
  // Comparing against the current state re-arms the row the moment the host's
  // patch lands, and only then.
  const [answeredIn, setAnsweredIn] = useState<RelocationItem['state'] | null>(null);
  const answered = answeredIn === item.state;

  if (item.state === 'queued') {
    return (
      <TranscriptItemShell role="tool" label="Worktree" ts={item.ts}>
        {/* Settled in tone, not in fact: the question is answered, so this is
            a one-line record like `moved`/`stayed` rather than a card — but it
            says when the move happens and keeps the one control that can still
            change the outcome. */}
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="truncate" title={item.path}>
            Moving to {name} when this turn ends
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 px-1 py-0 text-xs"
            disabled={answered}
            onClick={() => {
              setAnsweredIn('queued');
              post({ t: 'cancel-relocation', id: sessionId, itemId: item.id });
            }}
            aria-label={`Cancel the queued move to ${name}`}
          >
            Cancel
          </Button>
        </div>
      </TranscriptItemShell>
    );
  }

  if (item.state !== 'pending') {
    return (
      <TranscriptItemShell role="tool" label="Worktree" ts={item.ts}>
        <div className="text-xs text-muted-foreground" title={item.path}>
          {item.state === 'moved' ? `Moved to ${name}` : 'Stayed'}
        </div>
      </TranscriptItemShell>
    );
  }

  const answer = (move: boolean) => {
    setAnsweredIn('pending');
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
          disabled={answered}
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

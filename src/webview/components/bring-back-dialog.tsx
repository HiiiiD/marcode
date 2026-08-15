import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useStore } from '../store';
import { folderName } from '../format';
import type { PaneState } from '../reducer';
import type { BringBackPlan } from '../../protocol/messages';

/**
 * Confirms the one genuinely destructive thing this panel can do: delete a
 * worktree and check its branch out in the main tree.
 *
 * So the refusals are the surface, not the happy path. Everything here is
 * arranged around the two questions a user actually has in front of it —
 * *what exactly will be deleted*, and *why can't I* — and both are answered in
 * the flow rather than in a tooltip, because a disabled control carries
 * `disabled:pointer-events-none` and can neither be hovered nor announced.
 *
 * The plan is refetched on every open, and again by the host at the moment of
 * the click. What is drawn here is a description of a directory's git state at
 * one instant; it is never the authority for acting on it.
 */
export function BringBackDialog({
  pane, open, onOpenChange,
}: { pane: PaneState; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, post } = useStore();
  const id = pane.summary.id;
  const plan = state.bringBackBySession[id];

  // Same pull-on-open as ContextDialog, and for a stronger reason: a plan can
  // be invalidated by anything the user does in another window — a `git add`
  // in the main tree is enough.
  useEffect(() => {
    if (open) { post({ t: 'request-bring-back', id }); }
  }, [open, id, post]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          {/* pr-7 clears the close button in the popup's top-right corner. */}
          <div className="border-b border-border pr-7 pb-2">
            <DialogTitle className="text-sm">Bring the branch back</DialogTitle>
          </div>
        </DialogHeader>

        <Body plan={plan} cwd={pane.summary.cwd} />

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            size="sm"
            disabled={plan?.ok !== true}
            // The accessible name opens with the visible text, so a voice user
            // saying what they can see actually activates this control
            // (WCAG 2.5.3) — and the rest of it names the consequence, which
            // "Bring it back" on its own does not.
            aria-label="Bring it back: remove the worktree and check the branch out"
            onClick={() => {
              post({ t: 'bring-back', id });
              onOpenChange(false);
            }}
          >
            Bring it back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Body({ plan, cwd }: { plan: BringBackPlan | undefined; cwd: string }) {
  if (!plan) {
    return (
      <div className="space-y-1.5 py-1" aria-busy="true">
        {[0, 1].map((i) => (
          // `bg-muted` is the popup's own surface, so a skeleton drawn in it
          // is invisible — the placeholder has to be a shade the surface is
          // not. Same reasoning as ContextDialog's.
          <div key={i} className="h-3 animate-pulse rounded bg-muted-foreground/20" />
        ))}
      </div>
    );
  }

  if (!plan.ok) {
    return (
      <div className="space-y-2">
        {/* Left border rather than a filled panel: this is a refusal to read,
            not an alarm. `role="alert"` because it can also arrive *while*
            the dialog is open — the host replies with a fresh plan when it
            turns an attempt down — and a silent swap would leave a screen
            reader user clicking a button that stopped working. */}
        <p role="alert" className="border-l-2 border-destructive/50 pl-2 text-muted-foreground">
          {plan.reason}
        </p>
        <p className="text-muted-foreground">
          Nothing has changed. Reopen this once that is sorted out.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground">Two steps, in this order:</p>
      {/* An ordered list, and the order is load-bearing rather than
          decorative: git refuses the same branch in two trees at once, so the
          checkout is only possible once the worktree is gone. Numbering it
          also says that a failure between the two leaves a middle state. */}
      <ol className="ml-4 list-decimal space-y-1">
        <li>
          Remove the worktree{' '}
          <span className="font-medium" title={plan.worktree}>{folderName(plan.worktree)}</span>
          {' '}from disk.
        </li>
        <li>
          Check{' '}
          <span className="font-medium">{plan.branch}</span>
          {' '}out in{' '}
          <span className="font-medium" title={plan.mainRoot}>{folderName(plan.mainRoot)}</span>.
        </li>
      </ol>
      {/* The two facts that decide whether this is safe, and neither is
          visible from the panel: uncommitted work was already checked (the
          plan would be a refusal otherwise), and the session follows. */}
      <p className="text-muted-foreground">
        This session moves with it. Your commits stay on the branch; the{' '}
        <span title={cwd}>directory</span> does not survive.
      </p>
    </div>
  );
}

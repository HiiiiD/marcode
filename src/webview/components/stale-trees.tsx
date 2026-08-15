import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useStore } from '../store';
import { folderName } from '../format';
import type { StaleTree } from '../../protocol/messages';

/**
 * The working trees this panel still touches, and the one action that ends
 * them.
 *
 * The pane header's bring-back door only exists while a session is *in* a
 * tree. Sessions move on, and sessions get deleted; the directory does not.
 * This is the surface for everything that outlived its session — which is why
 * the fact each row leads with is whether anything is still in it, and why the
 * unowned rows are the point rather than an edge case.
 *
 * Removal is the same operation the header offers, refusals included: the host
 * re-plans at the click, and answers with a fresh sweep either way. So a
 * refusal here is not a toast that disappears — it is the row, still listed,
 * now carrying the line that stopped it.
 */
export function StaleTreesDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, post } = useStore();
  const trees = state.staleTrees;

  // Same pull-on-open as BringBackDialog, and for the same reason: a sweep
  // describes the disk at one instant, and a `git add` in another window is
  // enough to invalidate every row in it.
  useEffect(() => {
    if (open) { post({ t: 'request-stale-trees' }); }
  }, [open, post]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 text-xs">
        <DialogHeader>
          {/* pr-7 clears the close button in the popup's top-right corner. */}
          <div className="border-b border-border pr-7 pb-2">
            <DialogTitle className="text-sm">Working trees</DialogTitle>
          </div>
        </DialogHeader>

        {trees.length === 0 ? (
          // Not an empty box: this dialog is also where a removal lands, and
          // the user needs to see that what they clicked actually happened.
          <p className="text-muted-foreground">
            Nothing left to sweep. Every working tree this panel knows about is gone.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {trees.map((tree) => (
              <Row
                key={tree.path}
                tree={tree}
                owner={state.sessions.find((s) => s.id === tree.sessionId)?.title}
                onRemove={() => post({ t: 'remove-stale-tree', path: tree.path })}
              />
            ))}
          </ul>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" />}>
            Close
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  tree, owner, onRemove,
}: { tree: StaleTree; owner: string | undefined; onRemove: () => void }) {
  const name = folderName(tree.path);
  const refused = tree.reason !== undefined;

  return (
    <li className="space-y-1 border-l-2 border-border pl-2">
      <div className="flex items-baseline gap-2">
        <span className="truncate font-medium" title={tree.path}>{name}</span>
        {tree.branch !== undefined && (
          <span className="truncate text-muted-foreground">{tree.branch}</span>
        )}
        {!tree.clean && (
          // Words, not a colored dot: this is the fact that decides whether
          // the row's only action is available, and a color alone says it to
          // nobody using a screen reader.
          <span className="shrink-0 text-destructive">uncommitted</span>
        )}
        <Button
          variant="outline"
          size="sm"
          className={cn('ml-auto shrink-0', !refused && 'text-destructive')}
          disabled={refused}
          // Opens with the visible text so a voice user saying what they can
          // see activates it (WCAG 2.5.3), and the rest names the consequence
          // — "Remove" alone does not say a directory is deleted.
          aria-label={`Remove ${name}: delete the worktree and check ${tree.branch ?? 'its branch'} out in the main tree`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
      <p className="text-muted-foreground">
        {owner !== undefined
          ? `In use by ${owner}. Removing it brings that session home.`
          : 'No session is in it. Your commits stay on the branch; the directory does not survive.'}
      </p>
      {tree.reason !== undefined && (
        // Left border rather than a filled panel: a refusal to read, not an
        // alarm. `role="alert"` because it can also arrive *while* the dialog
        // is open — a removal the host turned down answers with a fresh sweep
        // — and a silent swap would leave a screen reader user clicking a
        // button that stopped working.
        <p role="alert" className="border-l-2 border-destructive/50 pl-2 text-muted-foreground">
          {tree.reason}
        </p>
      )}
    </li>
  );
}

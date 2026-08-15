import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  const heading = useRef<HTMLHeadingElement>(null);

  // Same pull-on-open as BringBackDialog, and for the same reason: a sweep
  // describes the disk at one instant, and a `git add` in another window is
  // enough to invalidate every row in it.
  useEffect(() => {
    if (open) { post({ t: 'request-stale-trees' }); }
  }, [open, post]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Focus is pinned to the heading rather than left to Base UI, which
        resolves it to the popup's first tabbable element. Here that is the
        first row's Remove control: the header holds no focusable and the
        footer's Close follows the list, so "open the sweep and press Enter"
        would land on a directory deletion. The two-step confirm below makes
        that first Enter harmless, and this makes it not happen at all —
        neither one alone is the fix.
      */}
      <DialogContent className="gap-3 text-xs" initialFocus={heading}>
        <DialogHeader>
          {/* pr-7 clears the close button in the popup's top-right corner. */}
          <div className="border-b border-border pr-7 pb-2">
            {/* tabIndex -1: focusable by the line above, never by Tab. */}
            <DialogTitle ref={heading} tabIndex={-1} className="text-sm outline-none">
              Working trees
            </DialogTitle>
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
  // The host answers a removal with a fresh sweep, which has to shell out to
  // git before it comes back. Until it does this row is unchanged and its
  // control is still live, so a second click sends a second removal for a
  // directory that is already going — the same reasoning as PermissionCard's
  // and RelocationCard's `answered`.
  const [removing, setRemoving] = useState(false);

  return (
    <li className="min-w-0 space-y-1 border-l-2 border-border pl-2">
      {/* Name and action only. The branch moved to the line below because
          `truncate` cannot shrink a flex item past its min-content width, and
          a branch like `feat/session-relocation` has no break opportunity in
          it — four items on one line push the button out of a 300px sidebar.
          `min-w-0` on the row and on every truncating span is the other half
          of that: without it the name does the same thing on its own. */}
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate font-medium" title={tree.path}>{name}</span>
        {/*
          Two steps, and the escape is first. Base UI focuses a menu's first
          item on open, so "open it and press Enter" must not be the gesture
          that deletes a directory — the same arrangement, and the same
          reason, as the roster row's nested `Delete…`. The ellipsis on the
          trigger is the visible promise that this opens a confirmation
          rather than acting on the way up from the click.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={refused || removing}
            render={(
              <Button
                variant="outline"
                size="sm"
                disabled={refused || removing}
                className={cn('ml-auto shrink-0', !refused && !removing && 'text-destructive')}
              />
            )}
            // Opens with the visible text so a voice user saying what they can
            // see activates it (WCAG 2.5.3), and the rest names the consequence
            // — "Remove" alone does not say a directory is deleted.
            aria-label={`Remove ${name}…: confirm deleting the worktree and checking ${tree.branch ?? 'its branch'} out in the main tree`}
          >
            Remove…
          </DropdownMenuTrigger>
          {/* `w-auto`, overriding the menu's default `w-(--anchor-width)`:
              anchored to a button this small, the confirm would be narrower
              than either of the two words it has to be read by. */}
          <DropdownMenuContent className="w-auto max-w-56">
            <DropdownMenuItem>Keep it</DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => { setRemoving(true); onRemove(); }}
            >
              {/* Named, not "Remove": several rows carry this menu and the
                  popup is the only thing on screen while it is open. */}
              <span className="min-w-0 truncate">Remove {name}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(tree.branch !== undefined || !tree.clean) && (
        <div className="flex min-w-0 items-baseline gap-2">
          {tree.branch !== undefined && (
            <span className="min-w-0 truncate text-muted-foreground">{tree.branch}</span>
          )}
          {!tree.clean && (
            // Words, not a colored dot: this is the fact that decides whether
            // the row's only action is available, and a color alone says it to
            // nobody using a screen reader.
            <span className="shrink-0 text-destructive">uncommitted</span>
          )}
        </div>
      )}
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

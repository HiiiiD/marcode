import {
  FileMinusIcon, FilePenLineIcon, FilePlusIcon, FileSymlinkIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { groupTree, summarize, type SessionGroup } from './fleet-diff-groups';
import { useStore } from './store';
import { folderName } from '@/format';
import type {
  ChangeOp, FileChange, SessionId, SessionSummary, TreeDiff,
} from '../protocol/messages';

/**
 * Every file the fleet has changed, grouped by the session that changed it.
 *
 * The list is the surface: this is VS Code's own source-control vocabulary —
 * a dense, indented file list with the churn on the right — rather than a
 * grid of cards, because the task is scanning many paths for the one worth
 * opening, and a card puts three lines of chrome between every two of them.
 *
 * It is an editor tab, not a panel surface. The panel is 300-500px in
 * practice, and this list — file paths, churn counts, session chips — did not
 * render there at all under the width gate it used to sit behind; an editor
 * tab has a whole column to itself and, unlike a panel takeover, leaves the
 * session panes and their permission cards on screen while a diff is being
 * read.
 *
 * What each row must survive being read as: the base line names what the diff
 * is measured against, because "12 files changed" since a branch point and
 * since HEAD are different claims about a session; and the unattributed group
 * is headed by the reason it exists, because a file nobody claimed is a real
 * answer — a build, a shell command, the user's own edit — not a gap in the
 * data.
 */
/**
 * React key for the unattributed group.
 *
 * Session keys are prefixed rather than used bare so the two namespaces cannot
 * collide: a session whose id happened to be the string below would otherwise
 * share a key with the unattributed group and make React reuse one's DOM for
 * the other. An earlier spelling used a NUL sentinel, which worked but turned
 * the whole file binary to `grep` and `git grep` — it silently vanished from
 * text searches. A prefix is the same guarantee in printable bytes.
 */
const UNATTRIBUTED_KEY = 'unattributed';

export function FleetDiff() {
  const { state, post } = useStore();
  const trees = state.fleetDiff;

  // Ask once on mount: the surface is the only thing that wants this, so it
  // is the only thing that asks for it.
  useEffect(() => { post({ t: 'request-fleet-diff' }); }, [post]);

  // And again, debounced, whenever the reducer counted something that could
  // have changed a diff. 750ms coalesces a burst of edits inside one turn
  // into a single request; without it a fan-out of file writes would put one
  // git invocation per tree on the host for every edit.
  useEffect(() => {
    if (state.fleetDiffDirty === 0) { return; }
    const timer = setTimeout(() => { post({ t: 'request-fleet-diff' }); }, 750);
    return () => { clearTimeout(timer); };
  }, [state.fleetDiffDirty, post]);

  return (
    <section aria-label="Changes" className="flex h-screen min-h-0 flex-col">
      {/*
        The same toolbar the picker above it uses — same height, same border,
        same control sizes. This surface takes over the whole panel body, and
        a header that announced itself with a different rhythm would read as
        a different application rather than the panel's second view.
      */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
        <h2 className="min-w-0 truncate font-medium">Changes</h2>
        {trees !== undefined && trees.length > 0 && (
          <span className="min-w-0 truncate text-muted-foreground">{summarize(trees)}</span>
        )}
        <Button
          variant="outline"
          size="icon-sm"
          className="ml-auto shrink-0"
          aria-label="Refresh: read every working tree again"
          onClick={() => post({ t: 'request-fleet-diff' })}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto text-xs">
        {state.fleetDiffReason !== undefined ? (
          // A failed read is a third state, and it has to be one: the loading
          // sentence below is the only other thing that could be on screen,
          // and leaving it there would report a permanent failure as work in
          // progress. Refresh is a live control in the header, so the way out
          // is already on screen.
          <div className="space-y-1 px-2 py-2">
            <p className="font-medium">Could not read the changes</p>
            <p className="text-muted-foreground">{state.fleetDiffReason}</p>
          </div>
        ) : trees === undefined ? (
          // A line, not a spinner: the answer is one git invocation per tree
          // and usually lands within a frame or two, and a spinner that
          // flashes for 80ms is noise where a sentence is an explanation.
          <p className="px-2 py-2 text-muted-foreground">Reading the working trees…</p>
        ) : trees.length === 0 ? (
          <div className="space-y-1 px-2 py-2">
            <p className="font-medium">Nothing to review</p>
            {/*
              Not "everything is clean". The host answers with a row per
              *repository* a session occupies — a clean one included, carrying
              no files — and drops a plain directory outright. So an empty
              answer says something narrower and stranger than "no changes":
              no session is sitting in a git repository at all. Reporting that
              as a clean fleet would be the one thing this surface must never
              do, which is imply an answer it was never given.
            */}
            <p className="text-muted-foreground">
              {state.sessions.length === 0
                ? 'No sessions yet, so there is no working tree to read.'
                : 'No session is in a git repository. A session in a plain directory has no diff to show.'}
            </p>
          </div>
        ) : (
          trees.map((tree) => <Tree key={tree.root} tree={tree} sessions={state.sessions} />)
        )}
      </div>
    </section>
  );
}

function Tree({ tree, sessions }: { tree: TreeDiff; sessions: SessionSummary[] }) {
  const groups = groupTree(tree);

  return (
    <div className="border-b border-border last:border-b-0">
      {/*
        Sticky, because a tree can carry 500 rows and the branch is the fact
        that says which of them you are reading. `bg-background` is load-bearing
        here — a transparent sticky header lets rows scroll through it.
      */}
      <div className="sticky top-0 z-10 space-y-0.5 bg-background px-2 pt-2.5 pb-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          {/*
            `h3`, under the surface's own `h2` — the same reasoning as the
            headings on a pane header: this list is designed to carry 500
            rows, and without structure a screen-reader user has one flat run
            of buttons and no way to move between trees or skip one. The
            levels say what the nesting already says visually: tree, then the
            sessions inside it.
          */}
          <h3 className="min-w-0 truncate font-medium" title={tree.root}>
            {folderName(tree.root)}
          </h3>
          {tree.branch !== undefined && (
            <span className="min-w-0 truncate text-muted-foreground">{tree.branch}</span>
          )}
        </div>
        {/* Named, never implied. `head` means uncommitted work only, and a
            list that let that pass for "everything this session did" would
            quietly under-report a session that had committed as it went. */}
        <p className="text-muted-foreground">
          {tree.base.kind === 'merge-base'
            ? `Since ${tree.base.ref} (${tree.base.sha.slice(0, 7)})`
            : 'Uncommitted changes only — nothing to compare a branch point against.'}
        </p>
      </div>

      <div className="px-2 pb-2.5">
        {tree.reason !== undefined ? (
          <p className="text-muted-foreground">{tree.reason}</p>
        ) : (
          groups.map((group) => (
            <Group
              key={group.sessionId === null ? UNATTRIBUTED_KEY : `session:${group.sessionId}`}
              group={group}
              tree={tree}
              sessions={sessions}
            />
          ))
        )}
        {tree.omitted > 0 && (
          // Never truncate silently: the cap is a rendering decision, and a
          // list that hid it would answer "what changed" with a number the
          // user cannot act on.
          <p className="mt-2 text-muted-foreground">
            {tree.omitted} more {tree.omitted === 1 ? 'file is' : 'files are'} not shown.
          </p>
        )}
      </div>
    </div>
  );
}

function Group({
  group, tree, sessions,
}: { group: SessionGroup; tree: TreeDiff; sessions: SessionSummary[] }) {
  const unattributed = group.sessionId === null;

  return (
    <div className="mt-2.5 first:mt-1">
      <div className="flex min-w-0 items-baseline gap-2 px-2">
        <h4 className={cn('min-w-0 truncate', unattributed ? 'text-muted-foreground' : 'font-medium')}>
          {group.sessionId === null
            ? 'Not attributed to a session'
            : titleOf(group.sessionId, sessions)}
        </h4>
        <Churn insertions={group.insertions} deletions={group.deletions} className="ml-auto" />
      </div>
      {unattributed && (
        // The sentence is the point of the group. Without it "not attributed"
        // reads as a bug in the attribution rather than as what it is: a
        // change no tool call in any transcript accounts for.
        <p className="px-2 pt-0.5 text-muted-foreground">
          No session recorded a tool call for these. A shell command, a build or your own
          edit changed them.
        </p>
      )}
      <ul className="mt-1">
        {group.files.map((file) => (
          <li key={file.path}>
            <FileRow file={file} tree={tree} sessions={sessions} own={group.sessionId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function titleOf(id: SessionId, sessions: SessionSummary[]): string {
  // Archived sessions are in the roster and deliberately in the diff: a closed
  // session's uncommitted work is still on disk and still unreviewed. Only a
  // deleted one falls through here.
  return sessions.find((s) => s.id === id)?.title ?? 'Deleted session';
}

const OP_ICON = {
  create: FilePlusIcon,
  modify: FilePenLineIcon,
  delete: FileMinusIcon,
  rename: FileSymlinkIcon,
} as const;

// VS Code's own source-control decoration colors, so a green path here means
// what a green path means three inches to the left in the SCM view. Carried
// by the icon alone — the path itself stays at full contrast, because it is
// the string being read, and `op` is already in the row's accessible name.
// Through the `--git-*` tokens rather than the raw VS Code variables: the
// gitDecoration group can be unset (see index.css), and an unresolvable colour
// leaves every op the same shade — which is the one thing colouring them was
// for.
const OP_COLOR: Record<ChangeOp, string> = {
  create: 'text-git-added',
  modify: 'text-git-modified',
  delete: 'text-git-deleted',
  rename: 'text-git-renamed',
};

const OP_WORD: Record<ChangeOp, string> = {
  create: 'added', modify: 'modified', delete: 'deleted', rename: 'renamed',
};

function FileRow({
  file, tree, sessions, own,
}: { file: FileChange; tree: TreeDiff; sessions: SessionSummary[]; own: SessionId | null }) {
  const { post } = useStore();
  const Icon = OP_ICON[file.op];
  const slash = file.path.lastIndexOf('/');
  const dir = slash === -1 ? '' : file.path.slice(0, slash + 1);
  const name = slash === -1 ? file.path : file.path.slice(slash + 1);
  // Only the *other* claimants: the group header already names this one, and
  // repeating it on every row would spend the row's remaining width saying
  // what the line above it just said.
  const others = file.claimedBy.filter((id) => id !== own);

  return (
    <Button
      variant="ghost"
      size="sm"
      // The full path, the operation and the churn: the visible row leads with
      // the basename and dims the directory, which is right for scanning and
      // wrong for anyone hearing the row one at a time.
      aria-label={`${file.path}: ${OP_WORD[file.op]}, ${file.insertions ?? 0} added, ${file.deletions ?? 0} removed. Open in the diff editor`}
      // No height override: `size="sm"` is 28px, which is what every other
      // list row in this panel is, and a 24px row here would make the one
      // dense list in the app the one that does not match.
      className="w-full justify-start gap-2 px-2 font-normal"
      onClick={() => post({
        t: 'open-file-diff', root: tree.root, path: file.path, base: tree.base,
      })}
    >
      <Icon aria-hidden className={OP_COLOR[file.op]} />
      {/*
        `dir` gives up its width first and the basename gives up its last: at
        700px a deep path has to lose something, and losing the end of
        `.../a.ts` would cost the only part of it the eye is scanning for.
        A weight, not `shrink-0` — a basename that cannot shrink also cannot
        truncate, so one long filename would push the churn column out of the
        row and clip the counts off the right edge instead of ellipsing the
        one string that had room to give.
      */}
      <span className="min-w-0 shrink-[8] truncate text-muted-foreground">{dir}</span>
      <span className="min-w-0 truncate">{name}</span>
      {file.op === 'rename' && file.from !== undefined && (
        <span className="min-w-0 shrink truncate text-muted-foreground" title={file.from}>
          from {file.from}
        </span>
      )}
      {others.length > 0 && (
        // Named, not counted. Two sessions writing one file is the situation
        // worth stopping on, and "+1" does not say who to go and read.
        <span className="min-w-0 shrink truncate text-muted-foreground">
          also {others.map((id) => titleOf(id, sessions)).join(', ')}
        </span>
      )}
      <Churn insertions={file.insertions} deletions={file.deletions} className="ml-auto" />
    </Button>
  );
}

function Churn({
  insertions, deletions, className,
}: { insertions?: number; deletions?: number; className?: string }) {
  // A binary file reports neither. Printing `+0 −0` would claim it did not
  // change, which is the one thing that is certainly false about it.
  if (insertions === undefined && deletions === undefined) {
    return <span className={cn('shrink-0 text-muted-foreground', className)}>binary</span>;
  }
  return (
    <span className={cn('shrink-0 tabular-nums', className)}>
      <span className="text-git-added">
        +{insertions ?? 0}
      </span>
      {' '}
      <span className="text-git-deleted">
        −{deletions ?? 0}
      </span>
    </span>
  );
}

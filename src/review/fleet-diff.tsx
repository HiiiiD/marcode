import { syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import {
  ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon, FileMinusIcon, FilePenLineIcon,
  FilePlusIcon, FileSymlinkIcon, RefreshCwIcon, XIcon,
} from 'lucide-react';
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/status-badge';
import {
  CHEVRON_TOGGLE_CLASS, Tree as FolderTree, TreeItem, TreeItemLabel,
} from '@/components/reui/tree';
import { cn } from '@/lib/utils';
import {
  buildFolderTree, commonPrefix, countFiles, filterTree, groupTree, summarize,
  type FolderNode, type SessionGroup,
} from './fleet-diff-groups';
import { useStore } from './store';
import { useFleetDiffRequests } from './use-fleet-diff-requests';
import { nextIndex, useRovingRows } from './use-roving-rows';
import { folderName } from '@/format';
import { MAX_FILE_CAP } from '../shared/file-cap';
import type {
  ChangeOp, FileChange, SessionId, SessionSummary, TreeDiff,
} from '../protocol/messages';

/** Pixel step per nesting level, fed to the vendored `Tree`'s own `indent`
 * prop and to `FileRow`'s matching inline indent — the two have to agree
 * pixel-for-pixel or a file would sit at a different depth than its own
 * folder row. */
const TREE_INDENT = 16;

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
 *
 * Two things on this surface only this panel can say, because both come from
 * the transcript's attribution rather than from git: a session group's own
 * live status (git sees a dirty tree; it has no idea the diff you are
 * reading right now is still being written), and which *other* session also
 * claimed a file — a contested file is the one situation in this whole list
 * worth stopping on, so it is named beside the basename rather than buried,
 * truncating, at the row's tail. That is why the group header is worth its
 * vertical space: a status glance VS Code's own SCM view is structurally
 * unable to offer.
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

/**
 * The tree header's rendered height, in pixels — pinned here so the sticky
 * group header below it can be given the exact same number rather than a
 * second, independent guess.
 *
 * `top-8` (32px) was the first guess and it undershot: the header is two
 * fixed-height rows — `pt-2.5` (10px) + the chevron row, whose tallest child
 * is the `icon-xs` `Button` at 24px + `space-y-0.5` (2px) + the `text-xs`
 * base-line row at its default 16px line-height + `pb-1.5` (6px) — 58px in
 * total, not 32. Both rows truncate rather than wrap, so this height is fixed
 * regardless of path length or branch name; nothing here depends on content
 * that can grow. `TREE_HEADER_HEIGHT` is applied as the header's own explicit
 * height (so it cannot silently drift from this number) and consumed again as
 * the group header's `top`. jsdom performs no layout, so no DOM test can
 * catch a future edit to the header's padding or row heights that stops
 * matching this constant — changing the header's rows means updating this
 * number by hand, and a screenshot is the only thing that verifies the
 * result.
 */
const TREE_HEADER_HEIGHT = 58;

/** One row's place in the flat, rendered order. */
interface Row {
  tree: TreeDiff;
  /** Same key `Group` computes for its own sticky header, reused here as the
   * other half of a row's identity — a file claimed by two sessions renders
   * once per claiming group, and `groupKey` is what tells those rows apart. */
  groupKey: string;
  file: FileChange;
  /** `${groupKey}::${file.path}` — this row's stable identity across a
   * rebuild, not its position. This surface re-reads its trees every 750ms
   * while agents work, and a row's *index* shifts whenever a file sorts in
   * ahead of it; the roving hook reconciles against this key instead of a
   * bare number so it keeps pointing at the same file, not the same slot. */
  key: string;
}

/**
 * The rendered rows, in the exact order `Tree`/`Group` put them on screen —
 * a collapsed tree or group contributes nothing, matching what `isCollapsed`
 * already hides there. Computed once per render so the roving index has a
 * stable count and the next/prev controls have somewhere to point; an index
 * into a row a collapse or filter just hid would land the reader — or the
 * next/prev control — on a file that is not on screen.
 */
function flattenRows(trees: TreeDiff[], collapsed: Set<string>): Row[] {
  const rows: Row[] = [];
  for (const tree of trees) {
    if (collapsed.has(`tree:${tree.root}`)) { continue; }
    if (tree.reason !== undefined) { continue; }
    for (const group of groupTree(tree)) {
      const groupKey = `${tree.root}::${group.sessionId ?? UNATTRIBUTED_KEY}`;
      if (collapsed.has(groupKey)) { continue; }
      const prefix = commonPrefix(group.files.map((f) => f.path));
      flattenFolder(buildFolderTree(group.files, prefix), tree, groupKey, collapsed, rows);
    }
  }
  return rows;
}

/** The key a folder's own collapse toggle uses, namespaced under its group
 * so the same directory name in two groups (or two working trees) never
 * collides in the shared `collapsed` set. */
function folderKey(groupKey: string, dirPath: string): string {
  return `${groupKey}::folder:${dirPath}`;
}

/**
 * Walks one group's nested folders depth-first — folders (recursed) before
 * files, matching `buildFolderTree`'s own sort — skipping the files under any
 * collapsed folder. This is the roving order: it decides which files Up/Down
 * and the next/prev header buttons visit, independent of how `Group` chooses
 * to render the same tree.
 */
function flattenFolder(
  node: FolderNode, tree: TreeDiff, groupKey: string, collapsed: Set<string>, rows: Row[],
): void {
  for (const folder of node.folders) {
    if (collapsed.has(folderKey(groupKey, folder.dirPath))) { continue; }
    flattenFolder(folder, tree, groupKey, collapsed, rows);
  }
  for (const file of node.files) {
    rows.push({ tree, groupKey, file, key: `${groupKey}::${file.path}` });
  }
}

/**
 * The roving-focus plumbing threaded down to every `FileRow`: which index is
 * focusable, which files have been opened this session, how many rows there
 * are in total (for `aria-setsize`), and how to move between them. Bundled
 * into one object rather than six separate props because every layer between
 * `FleetDiff` and `FileRow` passes all six through unchanged.
 */
interface RowNav {
  rowIndex: Map<string, number>;
  rowCount: number;
  active: number;
  opened: Set<string>;
  onFocus: (index: number) => void;
  onOpen: (index: number) => void;
}

export function FleetDiff() {
  const { state, post } = useStore();
  const trees = state.fleetDiff;

  const { showMore, refresh, atCeiling } = useFleetDiffRequests(
    post, state.visible, state.fleetDiffDirty,
  );

  const [query, setQuery] = useState('');
  const [contestedOnly, setContestedOnly] = useState(false);
  const filtered = (trees ?? []).map((tree) => filterTree(tree, query, contestedOnly));
  const shown = countFiles(filtered);
  const total = countFiles(trees ?? []);
  // How many files each tree carried *before* the filter, keyed by root —
  // the only way to tell "the filter emptied this tree" apart from "this
  // tree was already empty because the repository is clean". Both look
  // identical on the filtered tree alone (`files: []`), and only the first
  // one is a reason to drop the tree's header below.
  const unfilteredFileCount = new Map((trees ?? []).map((tree) => [tree.root, tree.files.length]));
  // `filterTree` never touches `omitted` — it counts files the *host* never
  // sent, and a filter over what already arrived cannot know whether they
  // would have matched. Summed across the unfiltered trees so the empty-filter
  // state below can tell "nothing matches" apart from "nothing matches among
  // what's loaded" and offer the way out either way.
  const totalOmitted = (trees ?? []).reduce((sum, tree) => sum + tree.omitted, 0);

  // Ephemeral by design. Both this and the opened set describe a reading
  // position in a list that re-reads itself every 750ms while agents work; a
  // restored collapse would be folding groups of a list assembled from a
  // different working tree than the one that was folded. Same reasoning that
  // keeps diff claims and failed model probes off disk.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) { next.add(key); }
    return next;
  });

  // A filter change is a new reading position, same as the collapse set
  // itself is ephemeral for: `filterTree`/`groupTree` drop a group entirely
  // once its matched files hit zero and re-add it under the same key once
  // they match again, so an un-pruned `collapsed` would silently re-hide a
  // group the filter just repopulated — exactly the files the filter was
  // widened to find. Clearing here, rather than pruning the vanished key on
  // every render, keeps the collapse set the single thing that decides
  // what's hidden instead of splitting that decision between two effects.
  useEffect(() => { setCollapsed(new Set()); }, [query, contestedOnly]);

  // A screen-reader-only echo of the visible count, above, updated only when
  // the filter itself changes — never by the 750ms poll that also moves
  // `shown`/`total`. Depending on `[query, contestedOnly]` alone, rather than
  // on the counts it reads, is what keeps a background re-read of an
  // unrelated tree from re-announcing a sentence the user never asked to hear
  // again.
  const [filterAnnouncement, setFilterAnnouncement] = useState('');
  useEffect(() => {
    if (query.trim() === '' && !contestedOnly) { setFilterAnnouncement(''); return; }
    setFilterAnnouncement(
      shown === total ? summarize(filtered) : `${shown} of ${total} files match this filter.`,
    );
  }, [query, contestedOnly]);

  // Ephemeral for the same reason `collapsed` is: it answers "have I read this
  // in *this* review", not across reloads, and a restored marker would be
  // ticking off files in a list assembled from a different working tree than
  // the one that was read. Keyed `${root}::${path}` rather than by path alone
  // — the same relative path in two trees is two different files.
  const [opened, setOpened] = useState<Set<string>>(new Set());

  const rows = flattenRows(filtered, collapsed);
  const rowIndex = new Map<string, number>();
  rows.forEach((row, i) => rowIndex.set(row.key, i));

  const {
    active, setActive, onKeyDown, containerRef, focusRow, onRowFocus, hadFocus,
  } = useRovingRows(rows.map((row) => row.key));

  const openRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) { return; }
    setOpened((prev) => {
      const next = new Set(prev);
      next.add(`${row.tree.root}::${row.file.path}`);
      return next;
    });
    setActive(index);
    // Moves real DOM focus, not just the roving index — the next/prev header
    // controls open a row the user never navigated to by keyboard, and
    // "Focus follows the roving index" has to hold for them too, not only
    // for arrow keys.
    focusRow(index);
    post({ t: 'open-file-diff', root: row.tree.root, path: row.file.path, base: row.tree.base });
  };

  const nav: RowNav = {
    rowIndex, rowCount: rows.length, active, opened, onFocus: onRowFocus, onOpen: openRow,
  };

  return (
    <section aria-label="Changes across every working tree" className="flex h-screen min-h-0 flex-col">
      {/*
        The same toolbar rhythm as the sidebar's own header — same height,
        same border, same control sizes — so this tab and the panel it opened
        from read as one application rather than two surfaces that happen to
        share a codebase.
      */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
        <h2 className="min-w-0 truncate font-medium">Changes</h2>
        {trees !== undefined && trees.length > 0 && (
          <span className="min-w-0 truncate text-muted-foreground">
            {shown === total ? summarize(filtered) : `${shown} of ${total} files`}
          </span>
        )}
        {/* Mounted for the life of the tab, same shape as `StatusBadge`'s own
            live region: only its text changes, and it changes only on a
            filter edit — never on the 750ms poll, which updates `shown` and
            `total` without touching `query` or `contestedOnly`. */}
        <span aria-live="polite" className="sr-only">{filterAnnouncement}</span>
        <div className="relative min-w-0 max-w-64">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter by path"
            placeholder="Filter by path"
            className={cn('h-7', query !== '' && 'pr-6')}
          />
          {query !== '' && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear filter"
              className="absolute top-0.5 right-0.5"
              onClick={() => setQuery('')}
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </div>
        <Button
          variant={contestedOnly ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={contestedOnly}
          onClick={() => setContestedOnly((on) => !on)}
        >
          Contested only
        </Button>
        {/*
          Next/prev walks the flat row order the roving index already counts,
          so the user never has to find the next file by eye in a 500-row
          list — the reason this control exists at all.
        */}
        <Button
          variant="outline"
          size="icon-sm"
          className="ml-auto shrink-0"
          aria-label="Open the previous file"
          disabled={rows.length === 0}
          onClick={() => {
            const next = nextIndex(active, 'ArrowUp', rows.length);
            if (next !== null) { openRow(next); }
          }}
        >
          <ArrowUpIcon aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          aria-label="Open the next file"
          disabled={rows.length === 0}
          onClick={() => {
            // On a tab nothing has focused or opened yet, `active` still
            // resolves to `0` by default (see `useRovingRows`) — advancing
            // from it with `nextIndex` would open row 1 and silently skip
            // row 0, the one file "Previous" would correctly open first.
            // Once the list has genuine focus, this is ordinary next-row
            // movement.
            const next = hadFocus ? nextIndex(active, 'ArrowDown', rows.length) : active;
            if (next !== null) { openRow(next); }
          }}
        >
          <ArrowDownIcon aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="shrink-0"
          aria-label="Refresh: read every working tree again"
          onClick={refresh}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-y-auto text-xs"
        onKeyDown={(e) => {
          // Only a row's own key events drive roving focus. Without this
          // guard, ArrowDown on a tree's collapse chevron or a "Show more"
          // button — both inside this same scroll container — would also
          // resolve through `onKeyDown` and teleport focus into a row the
          // user never asked to move to.
          if (!(e.target as HTMLElement).hasAttribute('data-review-row')) { return; }
          onKeyDown(e);
        }}
        // Programmatically focusable only (`-1`, never in the Tab order):
        // the fallback focus target when the active row's own node has
        // disappeared and there is no row left to hand focus to instead.
        tabIndex={-1}
      >
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
        ) : shown === 0 && total > 0 ? (
          <div className="space-y-1 px-2 py-2">
            {/*
              "No file matches this filter" is only true of the files this
              client actually has. A cap can withhold files the host never
              sent, and a match could be sitting among them — the filter has
              no way to know either way, so it must not claim there isn't
              one. This is also the one place in the empty state that needs a
              way out: with every tree replaced by this branch, the per-tree
              "Show more" button that would normally offer it is gone too.
            */}
            <p className="text-muted-foreground">
              {totalOmitted > 0
                ? 'No file matches this filter among the files loaded so far.'
                : 'No file matches this filter.'}
            </p>
            {totalOmitted > 0 && (
              <Button variant="outline" size="sm" onClick={showMore} disabled={atCeiling}>
                {atCeiling
                  ? `${totalOmitted} more, past the ${MAX_FILE_CAP}-file limit`
                  : `Show ${totalOmitted} more`}
              </Button>
            )}
          </div>
        ) : (
          // A filter that empties one tree's files, while others still match,
          // must drop that tree rather than leave a header — and a "Show N
          // more" button — over nothing. But a tree with `files: []` and no
          // `reason` is also exactly what a *clean* repository looks like
          // (SessionManager reports one row per repo a session occupies,
          // clean ones included) — dropping it unconditionally would make a
          // clean repo indistinguishable from one never read, the same
          // implied-answer mistake the "Nothing to review" copy above is
          // careful to avoid. So the drop is conditional on the filter
          // actually having removed something: only when this tree carried
          // files before the filter ran. A tree reporting a read failure
          // (`reason`) has no files to filter and always stays regardless —
          // the filter narrows *files*, not which working trees this surface
          // reports on.
          filtered
            .filter((tree) => tree.reason !== undefined
              || tree.files.length > 0
              || unfilteredFileCount.get(tree.root) === 0)
            .map((tree) => (
              <Tree
                key={tree.root}
                tree={tree}
                sessions={state.sessions}
                onShowMore={showMore}
                atCeiling={atCeiling}
                collapsed={collapsed}
                toggle={toggle}
                nav={nav}
              />
            ))
        )}
      </div>
    </section>
  );
}

function Tree({
  tree, sessions, onShowMore, atCeiling, collapsed, toggle, nav,
}: {
  tree: TreeDiff; sessions: SessionSummary[]; onShowMore: () => void; atCeiling: boolean;
  collapsed: Set<string>; toggle: (key: string) => void; nav: RowNav;
}) {
  const groups = groupTree(tree);
  const treeKey = `tree:${tree.root}`;
  const isCollapsed = collapsed.has(treeKey);
  const name = folderName(tree.root);

  return (
    <div className="border-b border-border last:border-b-0">
      {/*
        Sticky, because a tree can carry 500 rows and the branch is the fact
        that says which of them you are reading. `bg-background` is load-bearing
        here — a transparent sticky header lets rows scroll through it.
      */}
      <div
        data-testid="tree-header"
        className="sticky top-0 z-10 space-y-0.5 bg-background px-2 pt-2.5 pb-1.5"
        style={{ height: TREE_HEADER_HEIGHT }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className={CHEVRON_TOGGLE_CLASS}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `Expand ${name}` : `Collapse ${name}`}
            onClick={() => toggle(treeKey)}
          >
            {isCollapsed ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
          </Button>
          {/*
            `h3`, under the surface's own `h2` — the same reasoning as the
            headings on a pane header: this list is designed to carry 500
            rows, and without structure a screen-reader user has one flat run
            of buttons and no way to move between trees or skip one. The
            levels say what the nesting already says visually: tree, then the
            sessions inside it.
          */}
          <h3 className="min-w-0 truncate text-sm font-medium" title={tree.root}>
            {name}
          </h3>
          {tree.branch !== undefined && (
            <span className="min-w-0 shrink-0 truncate rounded-[min(var(--radius-md),8px)] bg-muted px-1.5 py-0.5 text-muted-foreground">
              {tree.branch}
            </span>
          )}
        </div>
        {/* Named, never implied. `head` means uncommitted work only, and a
            list that let that pass for "everything this session did" would
            quietly under-report a session that had committed as it went. */}
        <p className="pl-6 text-muted-foreground">
          {tree.base.kind === 'merge-base'
            ? `Since ${tree.base.ref} (${tree.base.sha.slice(0, 7)})`
            : 'Uncommitted changes only — nothing to compare a branch point against.'}
        </p>
      </div>

      {isCollapsed ? null : (
        <div className="pb-2.5">
          {tree.reason !== undefined ? (
            <p className="px-2 text-muted-foreground">{tree.reason}</p>
          ) : (
            groups.map((group) => (
              <Group
                key={group.sessionId === null ? UNATTRIBUTED_KEY : `session:${group.sessionId}`}
                group={group}
                tree={tree}
                sessions={sessions}
                collapsed={collapsed}
                toggle={toggle}
                nav={nav}
              />
            ))
          )}
          {tree.omitted > 0 && (
            // Never a dead end. The cap is a rendering decision, and a sentence
            // naming a number the user cannot act on is worse than either
            // showing the rows or not mentioning them. Disabled once the cap
            // is already at the ceiling: past `MAX_FILE_CAP` the host keeps
            // returning the same `omitted` no matter how many more times this
            // is pressed, and a button that never becomes a no-op-free action
            // again is the same dead end this control exists to remove.
            <Button
              variant="outline"
              size="sm"
              className="mx-2 mt-2"
              onClick={onShowMore}
              disabled={atCeiling}
            >
              {atCeiling ? `${tree.omitted} more, past the ${MAX_FILE_CAP}-file limit` : `Show ${tree.omitted} more`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** What `useTree`'s `dataLoader` resolves an id to: a folder's own node (the
 * synthetic root included — headless-tree never renders it, only reads its
 * children) or one leaf file. */
type FolderItemData =
  | { kind: 'folder'; node: FolderNode }
  | { kind: 'file'; file: FileChange };

/** `folder:${dirPath}` for a folder, the bare path for a file — a folder's id
 * is namespaced so it can never collide with a file whose own path happens to
 * read the same as a directory's. */
function folderItemId(dirPath: string): string {
  return `folder:${dirPath}`;
}

function childIds(node: FolderNode): string[] {
  return [
    ...node.folders.map((folder) => folderItemId(folder.dirPath)),
    ...node.files.map((file) => file.path),
  ];
}

/** Flattens a group's folder tree into the id→data/children map `useTree`'s
 * `dataLoader` reads by id — built fresh each render from `buildFolderTree`'s
 * output, the same way `groupTree`/`filterTree` are recomputed each render
 * rather than cached, since the underlying files change every 750ms poll. */
function indexFolderTree(root: FolderNode): {
  index: Map<string, FolderItemData>; childrenOf: Map<string, string[]>; folderDirPaths: string[];
} {
  const index = new Map<string, FolderItemData>();
  const childrenOf = new Map<string, string[]>();
  const folderDirPaths: string[] = [];

  const walk = (node: FolderNode, id: string) => {
    index.set(id, { kind: 'folder', node });
    childrenOf.set(id, childIds(node));
    for (const folder of node.folders) {
      folderDirPaths.push(folder.dirPath);
      walk(folder, folderItemId(folder.dirPath));
    }
    for (const file of node.files) {
      index.set(file.path, { kind: 'file', file });
    }
  };
  walk(root, '');

  return { index, childrenOf, folderDirPaths };
}

function Group({
  group, tree, sessions, collapsed, toggle, nav,
}: {
  group: SessionGroup; tree: TreeDiff; sessions: SessionSummary[];
  collapsed: Set<string>; toggle: (key: string) => void; nav: RowNav;
}) {
  const unattributed = group.sessionId === null;
  const title = group.sessionId === null
    ? 'Not attributed to a session'
    : titleOf(group.sessionId, sessions);
  // Undefined for the unattributed group and for a session that has been
  // deleted since — `titleOf` covers "deleted" in the title text already,
  // but a live-status badge has nothing true to claim about a session that
  // is gone, so it renders nothing rather than looking up `undefined.status`.
  const session = group.sessionId === null
    ? undefined
    : sessions.find((s) => s.id === group.sessionId);
  const groupKey = `${tree.root}::${group.sessionId ?? UNATTRIBUTED_KEY}`;
  const isCollapsed = collapsed.has(groupKey);
  const prefix = commonPrefix(group.files.map((f) => f.path));
  const folderRoot = buildFolderTree(group.files, prefix);
  const { index, childrenOf, folderDirPaths } = indexFolderTree(folderRoot);

  // Controlled expand state: derived from the same `collapsed` set the tree
  // and group headers already toggle through, not a second, independent
  // state — a folder is expanded exactly when its own key is absent from it.
  //
  // Memoized on a signature, not recomputed as a bare array every render:
  // `useTree` re-syncs its own React state from this array during render
  // (the same "adjust state during render" pattern `useRovingRows` above
  // uses deliberately) whenever it sees a *new reference*, content aside. A
  // fresh array every render — equal contents, different identity — reads as
  // "the controlled value changed" forever, which is a render-phase setState
  // every render: React's "too many re-renders" guard, not a slow leak.
  const expandedSignature = folderDirPaths
    .filter((dirPath) => !collapsed.has(folderKey(groupKey, dirPath)))
    .join(' ');
  const expandedItems = useMemo(
    () => (expandedSignature === '' ? [] : expandedSignature.split(' ').map(folderItemId)),
    [expandedSignature],
  );

  const folders = useTree<FolderItemData>({
    rootItemId: '',
    getItemName: (item) => {
      const data = item.getItemData();
      return data.kind === 'folder' ? data.node.name : basename(data.file.path);
    },
    isItemFolder: (item) => item.getItemData().kind === 'folder',
    dataLoader: {
      getItem: (id) => index.get(id)!,
      getChildren: (id) => childrenOf.get(id) ?? [],
    },
    state: { expandedItems },
    setExpandedItems: (updater) => {
      // headless-tree hands back the full next list (or, per its `Updater`
      // type, a function from the old list to it — every call observed in
      // practice passes the plain array, but the type covers both), not the
      // one id that changed — this app's own toggle only flips one key at a
      // time, so the reconciliation is a diff against the *previous*
      // expanded set, not a wholesale replace. A single `expand()`/
      // `collapse()` call (this app never invokes bulk expand/collapse)
      // changes exactly one entry.
      const next = typeof updater === 'function' ? updater(expandedItems) : updater;
      const nextExpanded = new Set(next);
      for (const dirPath of folderDirPaths) {
        const key = folderKey(groupKey, dirPath);
        const wasExpanded = !collapsed.has(key);
        if (wasExpanded !== nextExpanded.has(folderItemId(dirPath))) { toggle(key); }
      }
    },
    // No hotkeysCoreFeature: this surface's own roving focus already owns
    // arrow-key navigation across every file, in every group, in every
    // working tree — a second, folder-scoped keyboard nav would fight it.
    // Folders expand by click alone, same as the tree/group chevrons above.
    features: [syncDataLoaderFeature],
  });

  // `syncDataLoaderFeature` reads the loader once and caches it; it does not
  // notice a new `index`/`childrenOf` on its own — the 750ms poll replaces
  // them wholesale, so every render that actually changed the files has to
  // tell the tree to re-read, the gotcha the spike for this feature caught.
  //
  // Done during render, not in a `useEffect` — the same render-phase-update
  // pattern `useRovingRows` above already uses, and for the same reason: an
  // effect runs one render *after* the props that triggered it, so
  // `folders.getItems()` — read directly below, in this same render's JSX —
  // would still answer from the *previous* file list for that one render.
  // For a file genuinely removed from `group.files`, that stale item is a
  // dangling id the (already-current) `dataLoader` closures above no longer
  // recognize, and resolving it throws (`sync dataLoader returned
  // undefined`) — reachable simply by a poll removing a row the user is
  // looking at. Rebuilding synchronously, before `getItems()` is ever read,
  // closes that window instead of racing it.
  //
  // Guarded by a ref, not called unconditionally: `rebuildTree()` calls
  // `useTree`'s own internal `setState`, and calling that every render
  // (matching content or not) is the same "too many re-renders" trap
  // `expandedItems` above was memoized to avoid — this only fires the render
  // after the group's *files* actually changed.
  //
  // A signature, not `group.files` itself: `groupTree`/`filterTree` rebuild
  // that array fresh every render regardless of whether anything in it
  // changed (documented where they're defined, in fleet-diff-groups.ts), so
  // comparing the array reference would never stay equal and the guard would
  // never hold.
  const filesSignature = group.files
    .map((file) => `${file.path}:${file.op}:${file.insertions}:${file.deletions}`)
    .join(' ');
  const lastFilesSignature = useRef(filesSignature);
  if (lastFilesSignature.current !== filesSignature) {
    lastFilesSignature.current = filesSignature;
    folders.rebuildTree();
  }

  return (
    <div className="mt-2.5 first:mt-1">
      <div
        data-testid="group-header"
        className="sticky z-[9] flex min-w-0 items-center gap-1.5 bg-background pl-4"
        style={{ top: TREE_HEADER_HEIGHT }}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          className={CHEVRON_TOGGLE_CLASS}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${title}` : `Collapse ${title}`}
          onClick={() => toggle(groupKey)}
        >
          {isCollapsed ? <ChevronRightIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
        </Button>
        <h4 className={cn('min-w-0 truncate text-xs', unattributed ? 'text-muted-foreground' : 'font-medium')}>
          {title}
        </h4>
        {/*
          Outside the `h4`, not inside it: `StatusBadge` carries its own
          `aria-live="polite"` region (see status-badge.tsx) so a status
          change announces on its own, once, without also re-announcing the
          heading it would join if nested inside it. Mounted unconditionally,
          not gated on `status !== 'idle'` — a live region created only once a
          session leaves idle announces nothing on the very transition it
          exists to announce, because its text already carries the new status
          the moment it first mounts. `StatusBadge` itself renders nothing
          visible for `idle`; the DOM node — and the region — stay put either
          way.
        */}
        {session !== undefined && !session.archived && (
          <StatusBadge status={session.status} hideIdle />
        )}
        <span className="min-w-0 shrink-0 truncate text-muted-foreground">
          {group.files.length}
          {' '}
          {group.files.length === 1 ? 'file' : 'files'}
        </span>
        <Churn insertions={group.insertions} deletions={group.deletions} className="ml-auto" />
      </div>
      {isCollapsed ? null : (
        <>
          {unattributed && (
            // The sentence is the point of the group. Without it "not attributed"
            // reads as a bug in the attribution rather than as what it is: a
            // change no tool call in any transcript accounts for.
            <p className="pl-4 pt-0.5 text-muted-foreground">
              No session recorded a tool call for these. A shell command, a build or your own
              edit changed them.
            </p>
          )}
          {prefix !== '' && (
            // Named once, above the rows, instead of on every row: a shared
            // directory repeated on every line spends the row's width saying
            // what this line already says.
            <p className="pl-4 pt-1 text-muted-foreground">{prefix}</p>
          )}
          {/*
            One flat container, folders and files interleaved in
            `folders.getItems()`'s own order (folders-then-files at every
            level, depth-first — the same order `flattenFolder` walks for
            roving) — not a nested `<ul>`: a folder row's indent is CSS
            (`--tree-padding`, `TREE_INDENT` per level), not DOM nesting, the
            same scheme the vendored `Tree` primitive uses.
          */}
          <FolderTree indent={TREE_INDENT} tree={folders} className="mt-1 space-y-0.5 border-l border-border pl-6">
            {folders.getItems().map((item) => {
              const data = item.getItemData();
              if (data.kind === 'folder') {
                return (
                  <TreeItem key={item.getId()} item={item}>
                    <TreeItemLabel />
                  </TreeItem>
                );
              }
              const { file } = data;
              // Position within the *whole* review, not just this group's own
              // folder tree — `aria-posinset`/`aria-setsize` are defined for a
              // conceptual set that need not match the DOM nesting (the same
              // mechanism a virtualized or paginated list uses), so a screen
              // reader can announce "row 12 of 340" while the file list stays
              // grouped by session, and nested by folder, on screen.
              const position = nav.rowIndex.get(`${groupKey}::${file.path}`);
              return (
                <FileRow
                  key={file.path}
                  file={file}
                  tree={tree}
                  sessions={sessions}
                  own={group.sessionId}
                  depth={item.getItemMeta().level}
                  groupKey={groupKey}
                  nav={nav}
                  posInSet={position === undefined ? undefined : position + 1}
                  setSize={nav.rowCount}
                />
              );
            })}
          </FolderTree>
        </>
      )}
    </div>
  );
}

/** The basename of a repo-relative path — the part a folder row's own name
 * doesn't already say. */
function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
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
  file, tree, sessions, own, depth, groupKey, nav, posInSet, setSize,
}: {
  file: FileChange; tree: TreeDiff; sessions: SessionSummary[]; own: SessionId | null; depth: number;
  groupKey: string; nav: RowNav; posInSet: number | undefined; setSize: number;
}) {
  const Icon = OP_ICON[file.op];
  const name = basename(file.path);
  // Only the *other* claimants: the group header already names this one, and
  // repeating it on every row would spend the row's remaining width saying
  // what the line above it just said.
  const others = file.claimedBy.filter((id) => id !== own);

  // A file claimed by two sessions renders once per claiming group, so the
  // index has to be looked up by group + path, not by path alone.
  const index = nav.rowIndex.get(`${groupKey}::${file.path}`) ?? -1;
  const isOpened = nav.opened.has(`${tree.root}::${file.path}`);

  return (
    <Button
      variant="ghost"
      size="sm"
      // The full path, the operation and the churn: the visible row leads with
      // the basename — its containing folders are already named by the rows
      // above it — which is right for scanning and wrong for anyone hearing
      // the row one at a time, so the accessible name still carries the
      // whole path.
      aria-label={`${file.path}: ${OP_WORD[file.op]}, ${file.insertions ?? 0} added, ${file.deletions ?? 0} removed. Open in the diff editor`}
      // Same conceptual set the folder rows above it are numbered against —
      // see the comment where this is computed, in `Group`.
      aria-posinset={posInSet}
      aria-setsize={setSize}
      // No height override: `size="sm"` is 28px, which is what every other
      // list row in the sidebar panel is, and a 24px row here would make
      // this the one dense list in the app that does not match.
      //
      // `depth * TREE_INDENT` matches the vendored `Tree`'s own
      // `--tree-padding` formula pixel-for-pixel — the two have to agree, or
      // a file would sit at a visibly different depth than its own folder.
      className="w-full justify-start gap-2 pr-2 font-normal"
      style={{ paddingLeft: depth * TREE_INDENT }}
      // Every row used to be its own stop in the tab order — 400 Tab presses
      // to reach row 400. Only the active row is tabbable; arrow keys move
      // the roving index (`useRovingRows`) the rest of the way, and focus
      // landing here (by Tab, or by the browser after a click) is what tells
      // the roving index to follow.
      data-review-row
      data-opened={isOpened ? 'true' : undefined}
      tabIndex={index === nav.active ? 0 : -1}
      onFocus={() => nav.onFocus(index)}
      onClick={() => nav.onOpen(index)}
    >
      <Icon aria-hidden className={OP_COLOR[file.op]} />
      {/* Dimmed once opened: the marker for "already read this" this task
          adds, ephemeral for the same reason `collapsed` is. */}
      <span className={cn('min-w-0 truncate', isOpened && 'text-muted-foreground')}>{name}</span>
      {others.length > 0 && (
        // Named, not counted, directly after the basename rather than at the
        // row's truncating tail: two sessions writing one file is the single
        // situation in this whole surface worth stopping on, and "+1" does
        // not say who to go and read.
        <Badge
          variant="outline"
          className="min-w-0 shrink truncate border-destructive/50 text-destructive"
          title={`Also ${others.map((id) => titleOf(id, sessions)).join(', ')}`}
        >
          Also {others.map((id) => titleOf(id, sessions)).join(', ')}
        </Badge>
      )}
      {file.op === 'rename' && file.from !== undefined && (
        <span className="min-w-0 shrink truncate text-muted-foreground" title={file.from}>
          from {file.from}
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

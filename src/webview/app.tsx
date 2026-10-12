import { useEffect, useRef, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { AgentsMdNudgeCard } from './components/agents-md-nudge-card';
import { HostLinkBanner } from './components/host-link-banner';
import { PaneGroup } from './components/pane-group';
import { RearrangeNotice } from './components/rearrange-notice';
import { SessionPicker } from './components/session-picker';
import { NARROW_PX, usePanelWidth } from './components/use-is-narrow';
import { rearrange, type AutoGridOptions } from '../client-core/auto-grid';
import { assignAt, leafSessionIds } from './components/layout-tree';
import { reconcilePaneLayout, rosterSessionIds } from './components/pane-layout';
import { UsageStrip } from './components/usage-strip';
import { useStore } from './store';

const MIN_PANE = { width: 320, height: 200 };

export function App() {
  const { state, post, setPendingSlot } = useStore();
  // A single observer on the panel root, shared by both children: they used
  // to each run their own `ResizeObserver` against their own root element,
  // and because one root carries padding the other doesn't, `contentRect`
  // (a content-box measurement) put them 16-32px apart — close enough to
  // NARROW_PX that the two disagreed near the threshold. One measurement,
  // passed down, makes that structurally impossible.
  const rootRef = useRef<HTMLDivElement>(null);
  const width = usePanelWidth(rootRef);
  // `> 0` because `usePanelWidth` reports 0 until the observer has fired, and
  // an unmeasured panel is not a narrow one — the boolean hook this replaced
  // started at `false`, and the layout must not flash stacked before the
  // first measurement lands.
  const narrow = width > 0 && width < NARROW_PX;
  const [offerRearrange, setOfferRearrange] = useState(false);
  // An unmeasured panel has no viewport to fit a grid to, so placement stays the old way until it is.
  const autoGrid = (): AutoGridOptions => ({
    enabled: state.autoGrid && width > 0, viewport: { width, height: window.innerHeight }, minPane: MIN_PANE,
  });

  const byIdKeys = Object.keys(state.byId);
  const rosterKey = state.sessions.map((s) => s.id).join(',');
  const paneIdsKey = leafSessionIds(state.layout.root).join(',');
  // Session ids this client has already offered a pane at least once (see
  // reconcilePaneLayout's doc comment): once a session is "known", removing
  // its pane is the user's choice (roster checkbox / close) and reconcile
  // must never put it back. Only a session whose `byId` snapshot arrives for
  // the very first time — a freshly created session — gets auto-appended.
  const knownSessionIdsRef = useRef<Set<string>>(new Set());

  // A pane's session can be deleted outright (removed from the roster
  // entirely, unlike close-session which only hides it) or a brand new
  // session can arrive that has no pane yet. The host doesn't drive this —
  // it has no concept of "which panes the client currently shows" beyond
  // the last `set-layout` it was told — so the client reconciles its own
  // layout against the roster on every roster/snapshot-arrival change.
  // reconcilePaneLayout() (pane-layout.ts) returns `layout: null` once the
  // layout already matches, so this doesn't loop.
  useEffect(() => {
    const roster = rosterSessionIds(state.sessions);
    let root = state.layout.root;
    let filledPendingSlot = false;

    // A session created via an empty slot's own "New" button, or via the
    // toolbar's "+ New" while an empty slot exists, should land in that
    // slot rather than get appended as a new top-level sibling by the
    // reconcile pass below — see `ClientState.pendingSlotPath`. Consumed
    // against the FIRST session that arrives newly-known, win or lose: a
    // stale path (the slot filled or vanished in the meantime) just falls
    // through to the ordinary append-at-top reconcile does for every other
    // freshly created session, rather than retrying.
    if (state.pendingSlotPath) {
      const arriving = byIdKeys.find((id) => roster.has(id) && !knownSessionIdsRef.current.has(id));
      if (arriving) {
        const filled = assignAt(root, state.pendingSlotPath, arriving);
        if (filled) { root = filled; filledPendingSlot = true; }
        setPendingSlot(null);
      }
    }

    const result = reconcilePaneLayout(
      root, roster, byIdKeys, knownSessionIdsRef.current, state.focusedSessionId ?? state.layout.focusedSessionId,
      autoGrid(),
    );
    knownSessionIdsRef.current = result.knownSessionIds;
    if (result.offerRearrange) { setOfferRearrange(true); }
    if (result.root) {
      post({ t: 'set-layout', layout: { ...state.layout, root: result.root } });
    } else if (filledPendingSlot) {
      post({ t: 'set-layout', layout: { ...state.layout, root } });
    }
  }, [byIdKeys.join(','), rosterKey, paneIdsKey, state.pendingSlotPath]);

  // `set-visible` must be posted whenever the *set of panes shown* changes,
  // independent of whether reconciliation above found anything to change —
  // after a clean reload the persisted layout already matches the roster
  // (reconcile is a no-op), but `SessionManager.visible` starts empty and
  // `ready`'s `hydrate` never calls `setVisible`, so without this every
  // restored pane would sit dead (no `session-patch` ever reaches it) until
  // the user happened to create or close a session. Keyed on `paneIdsKey`
  // alone so it doesn't re-fire on every render, only when the shown pane
  // set actually changes.
  useEffect(() => {
    post({ t: 'set-visible', sessionIds: leafSessionIds(state.layout.root) });
  }, [paneIdsKey]);

  // `rootRef` is attached to a div that mounts unconditionally — including
  // during the pre-hydrate `Loading…` state — so `usePanelWidth`'s effect (it
  // runs once, keyed on the `ref` object's identity, which doesn't change
  // across a ready/not-ready re-render) observes the real element from the
  // start rather than binding to a `Loading…` node that's gone by the time
  // hydrate replaces it. `data-narrow-observer` marks this as the one
  // element whose width `usePanelWidth` tracks — `resizeTo` (in
  // src/test/dom/setup.ts) uses it to target only this observer's callback,
  // since react-resizable-panels registers its own `ResizeObserver`s on
  // panel/group elements that expect a different entry shape.
  //
  // One `TooltipProvider` at the root, so adjacent tooltips share a delay group:
  // without it every tooltip runs its own timer and moving between two
  // usage chips re-incurs the full open delay each time.
  return (
    <TooltipProvider>
      <Toaster position="bottom-right" />
      <div ref={rootRef} data-narrow-observer className="flex h-screen flex-col">
        <HostLinkBanner />
        {state.ready ? (
          <>
            <SessionPicker
              narrow={narrow}
              onReview={() => post({ t: 'open-review' })}
              onFleet={() => post({ t: 'open-fleet' })}
              onHistory={() => post({ t: 'open-history' })}
            />
            {offerRearrange && (
              <RearrangeNotice
                onRearrange={() => {
                  const { viewport, minPane } = autoGrid();
                  post({ t: 'set-layout', layout: { ...state.layout, root: rearrange(state.layout.root, viewport, minPane) } });
                  setOfferRearrange(false);
                }}
                onKeep={() => setOfferRearrange(false)}
                onExpand={width < 2 * MIN_PANE.width ? () => post({ t: 'expand-sidebar' }) : undefined}
              />
            )}
            <AgentsMdNudgeCard />
            <div className="min-h-0 flex-1">
              <PaneGroup narrow={narrow} />
            </div>
            <UsageStrip />
          </>
        ) : (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        )}
      </div>
    </TooltipProvider>
  );
}

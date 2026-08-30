import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { LogInIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
// react-resizable-panels ships ESM-only; a type-only import from a CommonJS
// module needs an explicit resolution-mode attribute (TS 5.3+) or tsc's
// per-file CJS/ESM interop check rejects it outright (TS1541) — see the
// similar note on the value import in the vendored resizable.tsx.
import type { Layout, LayoutChangedMeta } from "react-resizable-panels" with { "resolution-mode": "import" };
import { findModel } from "../../shared/model-catalog";
import { ENABLED_PROVIDERS_SETTING } from "../../shared/settings";
import { unavailabilityFor } from "../lib/provider-availability";
import { isSignInFailure } from "../lib/provider-login";
import { useStore } from "../store";
import { Composer } from "./composer";
import { accessibleTitles, rosterSessionIds, visiblePanes } from "./pane-layout";
import { SessionCreateMenu } from "./session-create-menu";
import { MessageScrollerProvider } from "@/components/ui/message-scroller";
import { SessionHeader } from "./session-header";
import { SubagentDrillInContext } from "./subagent-drill-in-context";
import { SubagentTranscript } from "./subagent-transcript";
import { Transcript } from "./transcript";

interface PaneGroupProps {
  /** Whether the panel is too narrow to split side by side. Measured once,
   * in `App`, and shared with `SessionPicker` — see `use-is-narrow.ts`. */
  narrow: boolean;
}

export function PaneGroup({ narrow }: PaneGroupProps) {
  const { state, post, focus } = useStore();

  // A pane can outlive `delete-session` on the client for a render or two,
  // and its stale `byId` entry is never cleaned up. Render only sessions
  // that are still in the roster (i.e. not deleted outright — archived
  // sessions DO keep rendering here if the user has them open; see
  // pane-layout.ts for why eligibility can't be "not archived") and have an
  // arrived snapshot.
  const roster = rosterSessionIds(state.sessions);
  const snapshotArrived = new Set(Object.keys(state.byId));
  const panes = visiblePanes(state.layout.panes, roster, snapshotArrived);
  const orientation = narrow ? "vertical" : state.layout.orientation;
  // Disambiguates title-derived accessible names (close button, resize
  // handles) when two or more visible panes share a title — most commonly
  // two freshly created sessions, both still 'Untitled'. See
  // accessibleTitles' doc comment in pane-layout.ts.
  const names = accessibleTitles(panes.map((p) => ({ id: p.sessionId, title: state.byId[p.sessionId].summary.title })));

  // Hiding a pane or deleting its session unmounts the pane. If the element
  // that held focus (e.g. the pane's own "Hide … from the split" button)
  // goes with it, the browser's `activeElement` getter falls back to
  // `<body>` per spec —
  // there is no focus event to hook, just that fallback. Left alone, a
  // keyboard user is silently dropped at the top of the document mid-task.
  // `prevCount` distinguishes "a pane just disappeared" from every other
  // reason this effect re-runs (e.g. a resize), so this only ever moves
  // focus in response to a pane actually going away, never on an unrelated
  // render. Runs as a (passive) effect, which React guarantees fires only
  // after the unmount has committed — `document.activeElement` already
  // reflects the fallback by the time this reads it.
  //
  // Prefers the surviving pane's own composer textarea — the control a user
  // who was just typing or hiding a pane is most likely to want next —
  // over the first `[data-slot="button"]` in what's left of the group.
  // That fallback used to be tried first, but the first such button in a
  // surviving pane is that pane's own "Hide … from the split" button: with
  // one keystroke, holding Enter after hiding a pane would walk the split
  // apart one pane per keypress, hiding the next one and refocusing the
  // *new* next one's hide button in a loop. The textarea has no such
  // recursive effect. When the last pane closes, that group renders its own
  // empty-state fallback instead (no `[data-slot="input-group-textarea"]`
  // or `[data-slot="button"]` when the roster still has sessions, just
  // hidden ones) — `rootRef.current` itself, made programmatically
  // focusable via `tabIndex={-1}`, is the last resort so focus always lands
  // on something real rather than failing silently. Both root elements
  // below carry `focus-visible:ring-2` so that last resort is not just real
  // but *visible* to a sighted keyboard user — the same ring every other
  // focusable control here uses (see `button.tsx`).
  const rootRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(panes.length);

  // A pane's reading position, not part of the pane's own layout — keyed by
  // sessionId (not pane index) so a session's drill-in survives the pane
  // reordering `evenlySizedPanes` can do, and is cleared, never restored, on
  // reload: a restored drill-in would describe a reading position nobody
  // checked this launch, the same reason review's collapse/opened-row state
  // stays ephemeral (see the review-tab invariant in CLAUDE.md).
  const [drilledIn, setDrilledIn] = useState<Record<string, string>>({});

  // With N panes rendered at identical weight there was no indication of
  // which one a keyboard or pointer user was actually acting in. It lives in
  // the store rather than in this component's own state because it is not
  // only a rendering concern: `+ New` inherits the provider, model, effort
  // and permission mode of the session the user is working in, and that
  // control renders in the roster toolbar, outside this tree. React's
  // `onFocusCapture` is backed by the native `focusin` event (unlike plain
  // `focus`, `focusin` bubbles), so one handler per pane catches focus
  // landing anywhere inside it — the header's model Select trigger, the
  // composer's textarea, a tool card's disclosure button — without needing
  // a listener per focusable descendant. `activeId` starts `null`: nothing
  // is "active" until something in the split has actually been focused.
  // Content rendered into a portal (e.g. an open Select's listbox) is not a
  // DOM descendant of the pane it logically belongs to, so focus moving
  // into a portalled menu does not bubble through this pane's tree and
  // does not update the focused id — the pane that opened the menu simply
  // stays active, which is the reading a user would want anyway.
  const activeId = state.focusedSessionId;
  useEffect(() => {
    if (panes.length < prevCount.current && document.activeElement === document.body) {
      const target =
        rootRef.current?.querySelector<HTMLElement>('[data-slot="input-group-textarea"]') ??
        rootRef.current?.querySelector<HTMLElement>('[data-slot="button"]') ??
        rootRef.current;
      target?.focus();
    }
    prevCount.current = panes.length;
  }, [panes.length]);

  // Nothing can be created. Three readings of one empty catalog, and they are
  // not interchangeable:
  //  - `probing`: nobody has answered yet. Not a verdict, so it is shown as a
  //    wait — a diagnosis here would accuse a healthy install for the second
  //    the CLI handshake takes.
  //  - settled with reasons: every enabled provider failed its probe.
  //  - settled without reasons: no provider is enabled at all, so nothing was
  //    ever asked. The remedy is a setting, not a retry.
  const noProviders = state.catalog.length === 0 && !state.probing;
  const noneEnabled = noProviders && state.unavailable.length === 0;
  const checking = state.catalog.length === 0 && state.probing;

  if (panes.length === 0) {
    return (
      <div
        ref={rootRef}
        tabIndex={-1}
        className={cn(
          "flex h-full flex-col items-center justify-center gap-2 p-4 text-center outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <p className="text-xs text-muted-foreground">
          {checking
            ? "Checking for agent backends…"
            : noneEnabled
              ? "No agent provider is enabled."
              : noProviders
                ? "No agent provider is available."
                : roster.size === 0
                  ? "No sessions yet. Start one to give an agent something to do."
                  : "No sessions in the split. Pick one from the roster above to show it here."}
        </p>
        {/* The one place the reasons are worth spelling out in full: `+ New`
            is disabled here and there is no session on screen to explain it.
            Rendered per provider, since a panel can be configured with
            several and only some of them broken. */}
        {noProviders &&
          state.unavailable.map((p) => (
            <div key={p.id} className="flex flex-col items-center gap-1">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{p.displayName}</span> — {p.reason}
              </p>
              {/* Login is a browser/TTY flow the extension hands to a
                  terminal — only offered when the reason names a specific
                  provider's sign-in state, never for a dead binary or an
                  unrecognized failure a login would not fix. */}
              {isSignInFailure(p.reason) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => post({ t: "login-provider", providerId: p.id })}
                >
                  <LogInIcon aria-hidden />
                  Log in
                </Button>
              )}
            </div>
          ))}
        {noneEnabled && (
          <>
            <p className="text-xs text-muted-foreground">
              Enable one in settings, then reload the window.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => post({ t: "open-settings", section: ENABLED_PROVIDERS_SETTING })}
            >
              <SettingsIcon aria-hidden />
              Open settings
            </Button>
          </>
        )}
        {/* Only where re-asking could change the answer. Re-probing IS the
            availability check (see SessionManager.refreshModels), so this is
            the whole remedy for an install that was fixed in a terminal while
            the panel sat open — but with nothing enabled there is nobody to
            ask, and a button that re-runs zero probes would just blink. */}
        {noProviders && !noneEnabled && (
          <Button size="sm" variant="outline" onClick={() => post({ t: "refresh-catalog" })}>
            <RefreshCwIcon aria-hidden />
            Check again
          </Button>
        )}
        {roster.size === 0 && !noProviders && !checking && <SessionCreateMenu />}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn("h-full outline-none", "focus-visible:ring-2 focus-visible:ring-ring")}
    >
      <ResizablePanelGroup
        orientation={orientation}
        aria-label="Open agent sessions"
        // `onLayoutChange` is deprecated and, for pointer-driven resizes,
        // fires on every pointermove — each call posts to the host AND
        // dispatches a local-layout re-render of every pane's Transcript
        // and Composer, turning a drag into a render/post storm.
        // `onLayoutChanged` fires once per completed change (pointer
        // release, or a single programmatic update) and reports whether it
        // was user-driven; skip the non-interactive call it also makes on
        // mount, since that one only echoes the layout already in state.
        onLayoutChanged={(layout: Layout, meta: LayoutChangedMeta) => {
          if (!meta.isUserInteraction) {
            return;
          }
          post({
            t: "set-layout",
            layout: {
              orientation: state.layout.orientation,
              panes: panes.map((p) => ({ sessionId: p.sessionId, size: layout[p.sessionId] ?? p.size })),
            },
          });
        }}
      >
        {panes.map((pane, index) => {
          const paneState = state.byId[pane.sessionId];
          const provider = state.catalog.find((p) => p.id === paneState.summary.providerId);
          const model = findModel(provider?.models ?? [], paneState.summary.model);
          return (
            <Fragment key={pane.sessionId}>
              {index > 0 && (
                <ResizableHandle
                  aria-label={`Resize between ${names.get(panes[index - 1].sessionId)} and ${names.get(paneState.summary.id)}`}
                  withHandle
                />
              )}
              <ResizablePanel
                id={pane.sessionId}
                aria-label={`Session: ${names.get(paneState.summary.id)}`}
                defaultSize={`${pane.size}%`}
                minSize="15%"
                collapsible
                data-active={activeId === pane.sessionId}
                onFocusCapture={() => focus(pane.sessionId)}
                className={cn(
                  "transition-colors",
                  // A ring, not a background: at 300px a filled active pane
                  // would compete with the permission card, which must stay
                  // the loudest thing on screen — it's the only transcript
                  // item demanding an action.
                  activeId === pane.sessionId && "ring-1 ring-ring/40 ring-inset",
                )}
              >
                {/* No `key` on the header or the composer: the Fragment
                    above is already keyed by sessionId, so the whole subtree
                    remounts when a pane changes session. Keying them
                    individually gave two siblings of the same children list
                    the same key ("Encountered two children with the same key,
                    s-…"), which lets React drop one of them. */}
                {/* The scroller's context wraps the whole pane, not just the
                    transcript: the header's active-subagent badge reveals an
                    item in this pane's transcript, and it is a sibling of the
                    transcript rather than a descendant. Chat-shaped, not
                    document-shaped — the latest item is pinned to the bottom
                    edge and history grows upward off the top. `end` rather
                    than `last-anchor`, which parks the newest user message at
                    the *top* of the viewport and streams the reply beneath
                    it: that reads as a document scrolling past, not a
                    conversation. One provider per pane, so two panes never
                    share a scroll position. */}
                <MessageScrollerProvider autoScroll defaultScrollPosition="end">
                  {(() => {
                    const openItemId = drilledIn[pane.sessionId];
                    const openItem = openItemId
                      ? paneState.items.find((i) => i.id === openItemId)
                      : undefined;
                    // `SubagentTranscript` swaps in whenever a drill-in is
                    // recorded AND still resolves to a `tool`-role item on
                    // this pane — a stale id (the item aged out of the
                    // window, or the session's history was reset) just falls
                    // through to the normal pane instead of throwing.
                    if (openItem && openItem.role === "tool") {
                      return (
                        <SubagentTranscript
                          item={openItem}
                          sessionId={paneState.summary.id}
                          title={paneState.summary.title}
                          onBack={() =>
                            setDrilledIn((prev) => {
                              const next = { ...prev };
                              delete next[pane.sessionId];
                              return next;
                            })
                          }
                        />
                      );
                    }
                    return (
                      <div className="flex h-full flex-col">
                        <SessionHeader
                          pane={paneState}
                          accessibleTitle={names.get(paneState.summary.id)!}
                        />
                        <SubagentDrillInContext.Provider
                          value={(itemId) =>
                            setDrilledIn((prev) => ({ ...prev, [pane.sessionId]: itemId }))
                          }
                        >
                          <div className="min-h-0 flex-1">
                            <Transcript
                              pane={paneState}
                              onLoadMore={(beforeItemId) =>
                                post({
                                  t: "load-more",
                                  id: pane.sessionId,
                                  beforeItemId,
                                })
                              }
                            />
                          </div>
                        </SubagentDrillInContext.Provider>
                        <Composer
                          pane={paneState}
                          model={model}
                          models={provider?.models ?? []}
                          unavailableReason={unavailabilityFor(state, paneState.summary.providerId)}
                        />
                      </div>
                    );
                  })()}
                </MessageScrollerProvider>
              </ResizablePanel>
            </Fragment>
          );
        })}
      </ResizablePanelGroup>
    </div>
  );
}

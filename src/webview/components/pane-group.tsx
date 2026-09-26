import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LogInIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useEffect, useRef } from "react";
// react-resizable-panels ships ESM-only; a type-only import from a CommonJS
// module needs an explicit resolution-mode attribute (TS 5.3+) or tsc's
// per-file CJS/ESM interop check rejects it outright (TS1541) — see the
// similar note on the value import in the vendored resizable.tsx.
import type { Layout, LayoutChangedMeta } from "react-resizable-panels" with { "resolution-mode": "import" };
import { ENABLED_PROVIDERS_SETTING, PROVIDER_INSTANCES_SETTING } from "../../shared/settings";
import type { LayoutNode } from "../../protocol/messages";
import { shouldOfferLogin } from "../lib/provider-login";
import { useStore } from "../store";
import { at, assignAt, freshTargetPath, removeSession, replaceAt, splitAt } from "./layout-tree";
import { LayoutNodeView } from "./layout-node-view";
import { PaneDragProvider } from "./pane-drag-context";
import { accessibleTitles, leafDisplayState, rosterSessionIds, visibleLeaves } from "./pane-layout";
import { SessionCreateMenu } from "./session-create-menu";

interface PaneGroupProps {
  /** Whether the panel is too narrow to split side by side. Measured once,
   * in `App`, and shared with `SessionPicker` — see `use-is-narrow.ts`. */
  narrow: boolean;
}

export function PaneGroup({ narrow }: PaneGroupProps) {
  const { state, post, focus } = useStore();

  // A pane can outlive `delete-session` on the client for a render or two,
  // and its stale `byId` entry is never cleaned up. Render only sessions
  // that are still in the roster (i.e. not deleted outright; see
  // pane-layout.ts for why eligibility is roster membership) and have an
  // arrived snapshot.
  const roster = rosterSessionIds(state.sessions);
  const snapshotArrived = new Set(Object.keys(state.byId));
  const leaves = visibleLeaves(state.layout.root, roster, snapshotArrived);
  const readyLeaves = leaves.filter((l) => l.state === "ready");
  // Disambiguates title-derived accessible names (close button, resize
  // handles) when two or more visible panes share a title — most commonly
  // two freshly created sessions, both still 'Untitled'. See
  // accessibleTitles' doc comment in pane-layout.ts.
  const names = accessibleTitles(
    readyLeaves.map((l) => ({ id: l.sessionId!, title: state.byId[l.sessionId!].summary.title })),
  );

  // Drag-to-split: the dragged session's own old leaf is removed first (it
  // may be the last pane the edge's own target leaf currently touches — see
  // `freshTargetPath`'s doc comment), then the target's post-removal path is
  // used to split it 50/50 in the edge's orientation. `insertBefore` — true
  // for a left/top edge — puts the dragged pane on the side it was dropped
  // on rather than always after the target, matching VS Code's own
  // editor-group convention.
  const handleSplit = (
    path: number[], orientation: "vertical" | "horizontal", draggedSessionId: string, insertBefore: boolean,
  ) => {
    const withoutDragged = removeSession(state.layout.root, draggedSessionId);
    const freshPath = freshTargetPath(state.layout.root, path, draggedSessionId, withoutDragged);
    if (!freshPath) { return; } // target vanished mid-drag — no-op, matches "errors are state"
    const next = splitAt(withoutDragged, freshPath, orientation, draggedSessionId, insertBefore);
    post({ t: "set-layout", layout: { ...state.layout, root: next } });
  };

  // Drag-to-assign: dropping directly on an empty leaf places the dragged
  // session there with no new split node — the same removal-then-recompute
  // as handleSplit, but assigning rather than splitting the target.
  const handleDropAssign = (path: number[], draggedSessionId: string) => {
    const withoutDragged = removeSession(state.layout.root, draggedSessionId);
    const freshPath = freshTargetPath(state.layout.root, path, draggedSessionId, withoutDragged);
    if (!freshPath) { return; }
    const next = assignAt(withoutDragged, freshPath, draggedSessionId);
    if (!next) { return; }
    post({ t: "set-layout", layout: { ...state.layout, root: next } });
  };

  const handleLayoutChanged = (path: number[], layout: Layout, meta: LayoutChangedMeta, children: LayoutNode[]) => {
    if (!meta.isUserInteraction) { return; }
    const target = at(state.layout.root, path);
    if (!target || target.kind !== "split") { return; }
    const resized: LayoutNode = {
      kind: "split",
      orientation: target.orientation,
      size: target.size,
      children: children.map((child, i) => ({ ...child, size: layout[`${path.join("-")}-${i}`] ?? child.size })),
    };
    post({ t: "set-layout", layout: { ...state.layout, root: replaceAt(state.layout.root, path, resized) } });
  };

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
  const prevCount = useRef(readyLeaves.length);

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
    if (readyLeaves.length < prevCount.current && document.activeElement === document.body) {
      const target =
        rootRef.current?.querySelector<HTMLElement>('[data-slot="input-group-textarea"]') ??
        rootRef.current?.querySelector<HTMLElement>('[data-slot="button"]') ??
        rootRef.current;
      target?.focus();
    }
    prevCount.current = readyLeaves.length;
  }, [readyLeaves.length]);

  // Nothing is "active" until something has actually been focused (see
  // `focusedSessionId`'s doc comment) — but on first load, or right after
  // the last pane closes and a new one opens, that honest `null` left `+
  // New` inheriting from nothing: `settingsFor` fell back to the catalog's
  // first provider, silently, with no ring on any pane to say so. Landing
  // real focus in the first pane's composer the moment panes exist and
  // nothing else claimed focus makes `activeId` true as soon as there is
  // an obvious answer, the same way a freshly opened document focuses its
  // first field. Guarded by `document.activeElement === document.body` so
  // this never steals focus the user already put somewhere else (the
  // roster, an open dialog) while sessions were still arriving.
  useEffect(() => {
    if (
      state.focusedSessionId === null &&
      readyLeaves.length > 0 &&
      document.activeElement === document.body
    ) {
      const target = rootRef.current?.querySelector<HTMLElement>(
        '[data-slot="input-group-textarea"]',
      );
      target?.focus();
    }
  }, [state.focusedSessionId, readyLeaves.length > 0]);

  // The host's pane commands land here as a request rather than a direct DOM
  // call: only this tree knows which composer is mounted.
  const request = state.paneFocusRequest;
  useEffect(() => {
    if (!request) { return; }
    const pane = rootRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(request.id)}"]`);
    const target = pane?.querySelector<HTMLElement>('[data-slot="input-group-textarea"]') ?? pane;
    target?.focus();
  }, [request]);

  const maximizedLeaf = state.maximizedId !== null && readyLeaves.some((l) => l.sessionId === state.maximizedId)
    ? ({ kind: "leaf", sessionId: state.maximizedId, size: 100 } as const)
    : null;
  const noop = () => undefined;

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

  if (readyLeaves.length === 0) {
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
              {shouldOfferLogin(p.reason, p.loginKind) && (
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
              onClick={() => post({
                t: "open-settings",
                section: `${ENABLED_PROVIDERS_SETTING} ${PROVIDER_INSTANCES_SETTING}`,
              })}
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
      <PaneDragProvider>
        <LayoutNodeView
          node={maximizedLeaf ?? state.layout.root}
          path={[]}
          topLevel
          narrow={narrow}
          leafState={(sessionId) => leafDisplayState(sessionId, roster, snapshotArrived)}
          names={names}
          activeId={activeId}
          onLayoutChanged={maximizedLeaf ? noop : handleLayoutChanged}
          onFocusCapture={focus}
          onSplit={maximizedLeaf ? noop : handleSplit}
          onDropAssign={maximizedLeaf ? noop : handleDropAssign}
        />
      </PaneDragProvider>
    </div>
  );
}

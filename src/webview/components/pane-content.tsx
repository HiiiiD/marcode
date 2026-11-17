import { useEffect, useRef, useState } from "react";
import { MessageScrollerProvider } from "@/components/ui/message-scroller";
import { findModel } from "../../shared/model-catalog";
import type { SessionId } from "../../protocol/messages";
import { ownerReason } from "../lib/owner-reason";
import { unavailabilityFor } from "../lib/provider-availability";
import { useStore } from "../store";
import { ChildrenList } from "./children-list";
import { Composer } from "./composer";
import { COMPACT_BELOW_WIDTH_PX, STRIP_BELOW_PX, STRIP_BELOW_WIDTH_PX, PaneDensityContext, type PaneDensity } from "./pane-density";
import { PinnedShell } from "./pinned-shell";
import { PinnedPrompts } from "./pinned-prompts";
import { SessionHeader } from "./session-header";
import { PaneRail } from "./pane-rail";
import { WorkingRow } from "./working-row";
import { SideChatBar } from "./side-chat-bar";
import { SubagentDrillInContext } from "./subagent-drill-in-context";
import { Transcript } from "./transcript";

interface PaneContentProps {
  sessionId: SessionId;
  /** The name this pane's own controls (rename, MCP popover trigger, …)
   * should announce — see `accessibleTitles` in `pane-layout.ts`. Active/
   * focus styling lives on the `ResizablePanel` this mounts inside
   * (`layout-node-view.tsx`), not here — that's a property of the slot in
   * the tree, not of the pane's own content. */
  accessibleTitle: string;
}

/**
 * One pane's content — header, transcript, composer — extracted from the
 * old flat renderer so it can mount at any depth in the `LayoutNode` tree,
 * not just as a flat top-level child. Reads its own session state and
 * catalog from the store rather than taking them as props, which keeps
 * `LayoutNodeViewProps` from ballooning with data every leaf can already
 * read directly.
 */
export function PaneContent({ sessionId, accessibleTitle }: PaneContentProps) {
  const { state, post } = useStore();
  const paneState = state.byId[sessionId];
  const provider = state.catalog.find((p) => p.id === paneState.summary.providerId);
  const model = findModel(provider?.models ?? [], paneState.summary.model);
  const rootRef = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState<PaneDensity>('comfortable');
  useEffect(() => {
    const el = rootRef.current;
    if (!el) { return; }
    const observer = new ResizeObserver(([entry]) => {
      const { height: h, width: w } = entry.contentRect;
      // Dead band so a pane sitting on a threshold does not flip layouts while a header or composer resizes it.
      setDensity((d) => {
        if (w < STRIP_BELOW_WIDTH_PX) { return 'rail'; }
        if (d === 'rail' && w < STRIP_BELOW_WIDTH_PX + 30) { return 'rail'; }
        if (h < STRIP_BELOW_PX) { return 'strip'; }
        if (d === 'strip' && h < STRIP_BELOW_PX + 30) { return 'strip'; }
        if (w < COMPACT_BELOW_WIDTH_PX) { return 'compact'; }
        return w > COMPACT_BELOW_WIDTH_PX + 40 ? 'comfortable' : d;
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const running = paneState.summary.status === "running" || paneState.summary.status === "awaiting-approval";

  return (
    // The scroller's context wraps the whole pane, not just the transcript:
    // the header's active-subagent badge reveals an item in this pane's
    // transcript, and it is a sibling of the transcript rather than a
    // descendant. Chat-shaped, not document-shaped — the latest item is
    // pinned to the bottom edge and history grows upward off the top. `end`
    // rather than `last-anchor`, which parks the newest user message at the
    // *top* of the viewport and streams the reply beneath it: that reads as
    // a document scrolling past, not a conversation. One provider per pane,
    // so two panes never share a scroll position.
    <PaneDensityContext.Provider value={density}>
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <div
        ref={rootRef}
        className="flex h-full flex-col"
        // Esc-to-stop, anywhere focus sits in this pane — header, transcript
        // or composer — not just the composer box. An Escape a descendant
        // already used for its own purpose (closing a mention menu,
        // cancelling a rename) calls `stopPropagation` before this ever
        // sees it; see composer.tsx and session-header.tsx.
        onKeyDown={(e) => {
          if (e.key === "Escape" && running) {
            e.preventDefault();
            post({ t: "interrupt", id: sessionId });
          }
        }}
      >
        {density === "rail" ? <PaneRail pane={paneState} /> : <SessionHeader pane={paneState} accessibleTitle={accessibleTitle} />}
        {density !== "strip" && density !== "rail" && (<>
        <SideChatBar sessionId={sessionId} />
        <ChildrenList sessionId={sessionId} />
        <SubagentDrillInContext.Provider
          value={(itemId) => post({ t: "open-fleet-subagent", sessionId, itemId })}
        >
          <div className="min-h-0 flex-1">
            <Transcript
              pane={paneState}
              onLoadMore={(beforeItemId) => post({ t: "load-more", id: sessionId, beforeItemId })}
            />
          </div>
        </SubagentDrillInContext.Provider>
        <PinnedPrompts pane={paneState} sessionId={sessionId} />
        <PinnedShell pane={paneState} sessionId={sessionId} />
        {paneState.summary.status === "running" && <WorkingRow pane={paneState} />}
        <Composer
          pane={paneState}
          model={model}
          models={provider?.models ?? []}
          unavailableReason={ownerReason(paneState.summary) ?? unavailabilityFor(state, paneState.summary.providerId)}
        />
        </>)}
      </div>
    </MessageScrollerProvider>
    </PaneDensityContext.Provider>
  );
}

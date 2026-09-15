import { MessageScrollerProvider } from "@/components/ui/message-scroller";
import { findModel } from "../../shared/model-catalog";
import type { SessionId } from "../../protocol/messages";
import { unavailabilityFor } from "../lib/provider-availability";
import { useStore } from "../store";
import { Composer } from "./composer";
import { SessionHeader } from "./session-header";
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
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <div className="flex h-full flex-col">
        <SessionHeader pane={paneState} accessibleTitle={accessibleTitle} />
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
        <Composer
          pane={paneState}
          model={model}
          models={provider?.models ?? []}
          unavailableReason={unavailabilityFor(state, paneState.summary.providerId)}
        />
      </div>
    </MessageScrollerProvider>
  );
}

// src/fleet/fleet-app.tsx
import { useEffect, useState } from 'react';
import { onHostMessage } from '@/vscode-api';
import { MessageScrollerProvider } from '@/components/ui/message-scroller';
import { useStore } from '../webview/store';
import { SubagentTranscript } from '../webview/components/subagent-transcript';
import { SessionPicker } from './session-picker';
import { SubagentList } from './subagent-list';
import type { SessionId } from '../protocol/messages';

export function FleetApp() {
  const { state } = useStore();
  const [selectedSessionId, setSelectedSessionId] = useState<SessionId | null>(null);
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);

  // Independent of the ClientState reducer's own onHostMessage subscription
  // (mounted by StoreProvider) — this is Fleet-only UI state with no home in
  // ClientState, so it listens for the one message type that reducer has no
  // case for (and correctly no-ops on, via its exhaustive switch's default
  // branch) rather than routing it through dispatch.
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.t !== 'fleet-focus-subagent') { return; }
      setSelectedSessionId(msg.sessionId);
      setSelectedSubagentId(msg.itemId);
    });
  }, []);

  return (
    // `App`'s own root anchors the sidebar's height chain with `h-screen`
    // (viewport-relative, so it needs no ancestor height) — every `h-full`
    // descendant, however many components deep, resolves against it.
    // `FleetApp` had no equivalent anchor: `SessionPicker`/`SubagentList`
    // never depend on height so the gap was invisible, but
    // `SubagentTranscript`'s root is `flex h-full flex-col`, and with no
    // ancestor establishing a real height (Fleet's html/body/#root never do
    // — see webview-html.ts), `height: 100%` resolved against nothing and
    // the whole subtree rendered at zero height. Same fix, same anchor.
    <div className="h-screen">
      {renderBody()}
    </div>
  );

  function renderBody() {
    if (!state.ready) {
      return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
    }

    if (!selectedSessionId) {
      return (
        <SessionPicker
          layout={state.layout}
          byId={state.byId}
          onPick={setSelectedSessionId}
        />
      );
    }

    const pane = state.byId[selectedSessionId];
    if (!pane) {
      // The session left the sidebar's split (closed, hidden) while Fleet
      // had it selected — back out to the picker rather than rendering a
      // session that no longer exists here.
      setSelectedSessionId(null);
      return null;
    }

    if (selectedSubagentId) {
      const item = pane.items.find((i) => i.id === selectedSubagentId);
      if (item && item.role === 'tool') {
        return (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <SubagentTranscript
              item={item}
              sessionId={pane.summary.id}
              title={pane.summary.title}
              onBack={() => setSelectedSubagentId(null)}
            />
          </MessageScrollerProvider>
        );
      }
      // A stale id (the item aged out, or the session reset) falls through
      // to the list instead of throwing — same tolerance PaneGroup's old
      // drill-in gave a stale id.
    }

    return (
      <SubagentList
        pane={pane}
        showSettled={showSettled}
        onToggleSettled={() => setShowSettled((v) => !v)}
        onOpen={setSelectedSubagentId}
        onBack={() => setSelectedSessionId(null)}
      />
    );
  }
}

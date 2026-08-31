// src/fleet/session-picker.tsx
import { Button } from '@/components/ui/button';
import { StatusBadge } from '../webview/components/status-badge';
import type { PaneState } from '../webview/reducer';
import type { PaneLayout, SessionId } from '../protocol/messages';

/**
 * The forced first step of the fleet tab: pick which of the sidebar's
 * visible sessions to look at. No "all sessions" option — see the fleet
 * subagent-filter design for why a merged view was rejected. `layout.panes`
 * (not the roster) is the source of the row order: a session split into the
 * sidebar is exactly Fleet's scope, nothing more.
 */
export function SessionPicker({
  layout, byId, onPick,
}: {
  layout: PaneLayout;
  byId: Record<SessionId, PaneState>;
  onPick: (id: SessionId) => void;
}) {
  if (layout.panes.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No sessions in the sidebar's split. Open one there first.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="text-xs text-muted-foreground">Pick a session to see its subagents.</p>
      {layout.panes.map((pane) => {
        const paneState = byId[pane.sessionId];
        if (!paneState) { return null; }
        return (
          <Button
            key={pane.sessionId}
            variant="outline"
            className="flex h-auto w-full items-center justify-between gap-2 p-2 text-left text-xs font-normal"
            onClick={() => onPick(pane.sessionId)}
          >
            <span className="truncate font-medium">{paneState.summary.title}</span>
            <StatusBadge status={paneState.summary.status} />
          </Button>
        );
      })}
    </div>
  );
}

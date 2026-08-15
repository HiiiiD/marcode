import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import { folderName } from '../format';
import type { SessionId, TranscriptItem } from '../../protocol/messages';
import { ToolBody } from './tool-body';
import { describeInput } from './tool-render';
import { TranscriptItemShell } from './transcript-item-shell';

type PermissionItem = Extract<TranscriptItem, { role: 'permission' }>;

export function PermissionCard({
  item, sessionId,
}: {
  item: PermissionItem;
  sessionId: SessionId;
}) {
  const { state, post } = useStore();
  const tool = item.tool;
  const server = tool.kind === 'mcp' ? tool.server : undefined;
  // The same description layer the transcript's tool cards use, so a request
  // looks the way the completed call will look — a shell command reads as a
  // command in both places, an edit reads as the same diff.
  const request = describeInput(tool);
  const cwd = state.byId[sessionId]?.summary.cwd ?? '';
  // `respondToPermission` is exactly-once on the host and silently drops a
  // second response for the same requestId. Without local state, both
  // buttons stay live until the session-patch round-trips back, so a
  // double-click (or Allow-then-panic-Deny) gets no feedback that the
  // second click did nothing. Disable both the instant either is clicked,
  // independent of the patch round trip.
  const [answered, setAnswered] = useState(false);

  if (item.state !== 'pending') {
    const label = server
      ? `${server} ${tool.label} — ${item.state}`
      : `${tool.label} — ${item.state}`;
    return (
      <TranscriptItemShell role="permission" label={label} ts={item.ts}>
        {item.reason && <div className="text-xs text-muted-foreground">{item.reason}</div>}
        <details className="text-xs">
          <summary className="cursor-default text-muted-foreground">What was requested</summary>
          <div className="mt-1">
            <ToolBody blocks={request} />
          </div>
        </details>
      </TranscriptItemShell>
    );
  }

  // A reloaded session is served from disk with `pending: []`, but a
  // persisted transcript item can still carry `state: 'pending'` from a
  // previous process (see AgentSession.dispose). Answering that item would
  // silently no-op — respondToPermission is exactly-once and drops a second
  // or late response. Only present live Allow/Deny controls when the host
  // still has this requestId outstanding; otherwise render it as stale so
  // the user isn't offered buttons that do nothing.
  const isLive = state.byId[sessionId]?.pending.some((p) => p.requestId === item.requestId) ?? false;

  if (!isLive) {
    return (
      <div className="my-0 rounded border-2 border-dashed border-muted-foreground/40 p-2 text-xs">
        <div className="mb-1 flex items-baseline gap-2 font-medium text-muted-foreground">
          {server && (
            // Muted, not colour-per-server — mirrors ToolCard's badge treatment.
            <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
              {server}
            </span>
          )}
          <span>{tool.label} — no longer awaiting a response</span>
        </div>
        <div className="mb-2">
          <ToolBody blocks={request} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled aria-label={`Deny ${tool.label} (unavailable)`}>Deny</Button>
          <Button variant="outline" size="sm" disabled aria-label={`Allow ${tool.label} (unavailable)`}>Allow</Button>
        </div>
      </div>
    );
  }

  const decide = (allow: boolean) => {
    // Set synchronously on first click, before the post — this is the only
    // thing standing between a double-click and a silently-dropped second
    // decision, since the host never acknowledges on the wire.
    setAnswered(true);
    post({
      t: 'permission-decision',
      id: sessionId,
      requestId: item.requestId,
      decision: allow ? { allow: true } : { allow: false, reason: 'Denied by user' },
    });
  };

  return (
    <div className="my-0 rounded border-2 border-destructive bg-destructive/10 p-2 text-xs">
      <div className="mb-1 flex items-baseline gap-2">
        {server && (
          // Muted, not colour-per-server — mirrors ToolCard's badge treatment.
          <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
            {server}
          </span>
        )}
        <span className="font-medium">Allow {tool.label}?</span>
        <span className="truncate text-muted-foreground" title={cwd}>{folderName(cwd)}</span>
      </div>
      <div className="mb-2">
        <ToolBody blocks={request} />
      </div>
      {/* Deny is the safe, reversible-feeling choice: it comes first in DOM
          and tab order, and Allow — the consequential, irreversible-feeling
          action — is deliberately not styled with solid-primary emphasis,
          so it isn't both the most prominent control and the first tab
          stop. Neither button autofocuses. */}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={answered}
          onClick={() => decide(false)}
          aria-label={`Deny ${tool.label}`}
        >
          Deny
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={answered}
          onClick={() => decide(true)}
          aria-label={`Allow ${tool.label}`}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}

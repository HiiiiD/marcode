import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import { folderName } from '../format';
import type { PermissionMeta, SessionId, TranscriptItem } from '../../protocol/messages';
import { ToolBody } from './tool-body';
import { describeInput } from './tool-render';
import { TranscriptItemShell } from './transcript-item-shell';

type PermissionItem = Extract<TranscriptItem, { role: 'permission' }>;

/**
 * What the backend's own permission engine already said about this request.
 *
 * Supporting detail, never the headline: the card's question stays "Allow
 * X?", because that is the decision being asked for, and this sits under it
 * in the same size as the rest of the body. Every field is optional and only
 * rendered when the provider sent it — there is no placeholder and no
 * invented copy, so a provider that reports nothing gets exactly the card it
 * had before.
 */
function PermissionMetaDetail({ meta }: { meta?: PermissionMeta }) {
  if (!meta) { return null; }
  const { title, description, decisionReason, blockedPath } = meta;
  if (!title && !description && !decisionReason && !blockedPath) { return null; }
  return (
    <div className="mb-2 flex flex-col gap-0.5">
      {title && <div className="wrap-break-word">{title}</div>}
      {description && <div className="wrap-break-word text-muted-foreground">{description}</div>}
      {decisionReason && (
        <div className="wrap-break-word text-muted-foreground">{decisionReason}</div>
      )}
      {blockedPath && (
        <div className="min-w-0 truncate font-mono text-muted-foreground" title={blockedPath}>
          {blockedPath}
        </div>
      )}
    </div>
  );
}

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
  // The backend's own name for the tool when it sent one — `displayName` is
  // what its permission engine would have shown — falling back to the neutral
  // label every other card uses. Used for the accessible names too, so the
  // button a screen reader announces names the same tool the heading does.
  const name = item.meta?.displayName ?? tool.label;
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
      ? `${server} ${name} — ${item.state}`
      : `${name} — ${item.state}`;
    return (
      <TranscriptItemShell role="permission" label={label} ts={item.ts}>
        {item.reason && <div className="text-xs text-muted-foreground">{item.reason}</div>}
        <details className="text-xs">
          <summary className="cursor-default text-muted-foreground">What was requested</summary>
          <div className="mt-1">
            <PermissionMetaDetail meta={item.meta} />
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
          <span>{name} — no longer awaiting a response</span>
        </div>
        <div className="mb-2">
          <PermissionMetaDetail meta={item.meta} />
          <ToolBody blocks={request} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled aria-label={`Deny ${name} (unavailable)`}>Deny</Button>
          <Button variant="outline" size="sm" disabled aria-label={`Allow ${name} (unavailable)`}>Allow</Button>
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
        <span className="font-medium">Allow {name}?</span>
        <span className="truncate text-muted-foreground" title={cwd}>{folderName(cwd)}</span>
      </div>
      <div className="mb-2">
        <PermissionMetaDetail meta={item.meta} />
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
          aria-label={`Deny ${name}`}
        >
          Deny
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={answered}
          onClick={() => decide(true)}
          aria-label={`Allow ${name}`}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}

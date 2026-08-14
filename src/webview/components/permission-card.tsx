import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useStore } from '../store';
import { folderName } from '../format';
import type { SessionId, TranscriptItem } from '../../protocol/messages';
import { safeStringify } from './tool-card-format';
import { TranscriptItemShell } from './transcript-item-shell';

type PermissionItem = Extract<TranscriptItem, { role: 'permission' }>;

function diffPreview(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) { return undefined; }
  const record = input as Record<string, unknown>;
  const path = typeof record.file_path === 'string' ? record.file_path : undefined;
  if (!path) { return undefined; }
  const oldText = typeof record.old_string === 'string' ? record.old_string : undefined;
  const newText = typeof record.new_string === 'string' ? record.new_string
    : typeof record.content === 'string' ? record.content : undefined;
  if (oldText === undefined && newText === undefined) { return undefined; }

  const lines = [`--- ${path}`];
  if (oldText !== undefined) {
    lines.push(...oldText.split('\n').map((l) => `- ${l}`));
  }
  if (newText !== undefined) {
    lines.push(...newText.split('\n').map((l) => `+ ${l}`));
  }
  return lines.join('\n');
}

export function PermissionCard({
  item, sessionId,
}: {
  item: PermissionItem;
  sessionId: SessionId;
}) {
  const { state, post } = useStore();
  const diff = diffPreview(item.input);
  const cwd = state.byId[sessionId]?.summary.cwd ?? '';
  // `respondToPermission` is exactly-once on the host and silently drops a
  // second response for the same requestId. Without local state, both
  // buttons stay live until the session-patch round-trips back, so a
  // double-click (or Allow-then-panic-Deny) gets no feedback that the
  // second click did nothing. Disable both the instant either is clicked,
  // independent of the patch round trip.
  const [answered, setAnswered] = useState(false);

  if (item.state !== 'pending') {
    const label = item.mcpServer
      ? `${item.mcpServer} ${item.name} — ${item.state}`
      : `${item.name} — ${item.state}`;
    return (
      <TranscriptItemShell role="permission" label={label} ts={item.ts}>
        {item.reason && <div className="text-xs text-muted-foreground">{item.reason}</div>}
        <details className="text-xs">
          <summary className="cursor-default text-muted-foreground">What was requested</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-1 wrap-break-word whitespace-pre-wrap">
{diff ?? safeStringify(item.input)}
          </pre>
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
          {item.mcpServer && (
            // Muted, not colour-per-server — mirrors ToolCard's badge treatment.
            <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
              {item.mcpServer}
            </span>
          )}
          <span>{item.name} — no longer awaiting a response</span>
        </div>
        <pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-1 wrap-break-word whitespace-pre-wrap">
{diff ?? safeStringify(item.input)}
        </pre>
        <div className="flex gap-2">
          <Button size="sm" disabled aria-label={`Deny ${item.name} (unavailable)`}>Deny</Button>
          <Button variant="outline" size="sm" disabled aria-label={`Allow ${item.name} (unavailable)`}>Allow</Button>
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
        {item.mcpServer && (
          // Muted, not colour-per-server — mirrors ToolCard's badge treatment.
          <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
            {item.mcpServer}
          </span>
        )}
        <span className="font-medium">Allow {item.name}?</span>
        <span className="truncate text-muted-foreground" title={cwd}>{folderName(cwd)}</span>
      </div>
      <pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-1 wrap-break-word whitespace-pre-wrap">
        {(diff ?? safeStringify(item.input)).split('\n').map((line, i) => (
          <div
            key={i}
            className={cn(
              line.startsWith('+') && 'text-(--vscode-gitDecoration-addedResourceForeground)',
              line.startsWith('-') && 'text-(--vscode-gitDecoration-deletedResourceForeground)',
            )}
          >
            {line}
          </div>
        ))}
      </pre>
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
          aria-label={`Deny ${item.name}`}
        >
          Deny
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={answered}
          onClick={() => decide(true)}
          aria-label={`Allow ${item.name}`}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}

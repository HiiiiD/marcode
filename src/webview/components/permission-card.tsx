import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import type { SessionId, TranscriptItem } from '../../protocol/messages';
import { safeStringify } from './tool-card-format';

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

  if (item.state !== 'pending') {
    return (
      <div className="my-2 rounded border border-border px-2 py-1 text-xs text-muted-foreground">
        {item.name} — {item.state}
        {item.reason ? `: ${item.reason}` : ''}
      </div>
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
      <div className="my-2 rounded border-2 border-dashed border-muted-foreground/40 p-2 text-xs">
        <div className="mb-1 font-medium text-muted-foreground">
          {item.name} — no longer awaiting a response
        </div>
        <pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-1">
{diff ?? safeStringify(item.input)}
        </pre>
        <div className="flex gap-2">
          <Button size="sm" disabled aria-label={`Allow ${item.name} (unavailable)`}>Allow</Button>
          <Button variant="outline" size="sm" disabled aria-label={`Deny ${item.name} (unavailable)`}>Deny</Button>
        </div>
      </div>
    );
  }

  const decide = (allow: boolean) => post({
    t: 'permission-decision',
    id: sessionId,
    requestId: item.requestId,
    decision: allow ? { allow: true } : { allow: false, reason: 'Denied by user' },
  });

  return (
    <div className="my-2 rounded border-2 border-destructive p-2 text-xs">
      <div className="mb-1 font-medium">Allow {item.name}?</div>
      <pre className="mb-2 max-h-48 overflow-auto rounded bg-muted p-1">
{diff ?? safeStringify(item.input)}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => decide(true)} aria-label={`Allow ${item.name}`}>Allow</Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => decide(false)}
          aria-label={`Deny ${item.name}`}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

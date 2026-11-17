import { useState } from 'react';
import { CheckIcon, ListChecksIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useStore } from '../store';
import { folderName } from '../format';
import type { PermissionMeta, SessionId, TranscriptItem } from '../../protocol/messages';
import { requestTitle } from '../lib/permission-copy';
import { Markdown } from './markdown';
import { ToolBody } from './tool-body';
import { GLYPHS } from './tool-card';
import { describeInput, describeTool } from './tool-render';
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
        <div className="flex items-start gap-1.5 wrap-break-word text-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-attention" />
          <span>{decisionReason}</span>
        </div>
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
    const allowed = item.state === 'allowed';
    // The same header the tool's own card will wear (Bash, PowerShell, Read, …), so the approval and the run read as one thing.
    const header = tool.kind === 'plan'
      ? { glyph: 'list-todo' as const, verb: 'Plan', primary: allowed ? 'approved · implementation started' : 'not approved · kept planning', mono: false }
      : describeTool(tool);
    const Glyph = GLYPHS[header.glyph];
    return (
      <details className="group/item my-0 text-xs">
        <summary className="flex cursor-default list-none items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted [&::-webkit-details-marker]:hidden">
          <Glyph aria-hidden className="shrink-0" />
          <span className="sr-only">{item.state}</span>
          {server && <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">{server}</span>}
          <span className="shrink-0 font-medium">{item.meta?.displayName ?? header.verb}</span>
          {header.primary && (
            <span className={cn('min-w-0 truncate text-muted-foreground', header.mono && 'font-mono')}>{header.primary}</span>
          )}
          {allowed
            ? <CheckIcon aria-hidden className="ml-auto shrink-0 text-git-added" />
            : <XIcon aria-hidden className="ml-auto shrink-0 text-destructive" />}
        </summary>
        <div className="mt-1 flex flex-col gap-1.5 pl-1">
          {item.reason && <div className="text-xs text-muted-foreground">{item.reason}</div>}
          <PermissionMetaDetail meta={item.meta} />
          {tool.kind === 'plan'
            ? <div className="max-h-64 overflow-y-auto border-l-2 border-border pl-2.5"><Markdown>{tool.text}</Markdown></div>
            : <ToolBody blocks={request} />}
        </div>
      </details>
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

  if (tool.kind === 'plan') {
    return (
      <div className="my-0 flex flex-col gap-2 rounded border border-attention/60 bg-attention/10 p-2 text-xs">
        <div className="flex items-center gap-2">
          <ListChecksIcon aria-hidden className="size-4 shrink-0 text-primary" />
          <span className="font-medium">Plan ready</span>
          <span className="truncate text-muted-foreground" title={cwd}>{folderName(cwd)}</span>
        </div>
        {tool.path && <ToolBody blocks={[{ kind: 'path', path: tool.path, hint: 'Markdown plan' }]} />}
        <div className="max-h-64 overflow-y-auto border-l-2 border-attention/40 pl-2.5">
          <Markdown>{tool.text}</Markdown>
        </div>
        <p className="text-foreground/80">
          Starting implementation will leave read-only Plan mode and allow file changes.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={answered}
            onClick={() => decide(false)}
          >
            Keep planning
          </Button>
          <Button
            size="sm"
            disabled={answered}
            onClick={() => decide(true)}
          >
            Start implementation
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="my-0 rounded border border-attention/60 bg-attention/10 p-2 text-xs">
      <div className="mb-1 flex items-baseline gap-2">
        {server && (
          // Muted, not colour-per-server — mirrors ToolCard's badge treatment.
          <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
            {server}
          </span>
        )}
        <span className="font-medium">{requestTitle(tool, name, item.meta?.displayName !== undefined)}</span>
        <span className="truncate text-muted-foreground" title={cwd}>{folderName(cwd)}</span>
      </div>
      <div className="mb-2">
        <PermissionMetaDetail meta={item.meta} />
        <ToolBody blocks={tool.kind === "mcp" ? request.filter((b) => !(b.kind === "field" && (b.label === "server" || b.label === "tool"))) : request} clamp={{ head: 4, tail: 2 }} />
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

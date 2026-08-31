import {
  MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Button } from '@/components/ui/button';
import { ChevronLeftIcon } from 'lucide-react';
import { PermissionCard } from './permission-card';
import { ToolCard } from './tool-card';
import { subagentLabel } from './subagent-window';
import type { SessionId, TranscriptItem } from '../../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/**
 * A subagent's complete tool-call history, unwindowed. Rendered only by
 * `src/fleet/fleet-app.tsx`, in place of `SubagentList` once a subagent is
 * selected there — `PaneGroup` no longer renders this component at all; a
 * `SubagentCard` in the sidebar instead asks the host to open the Fleet tab
 * on this subagent (see subagent-drill-in-context.ts). No `hasMore`/
 * pagination: a subagent's children are a fixed list already fully present
 * in `item.children`, never paged from the host.
 *
 * `FleetApp` mounts its own `MessageScrollerProvider` around this component
 * (it is not a pane, and has no `PaneGroup` provider to inherit), so this
 * needs no provider of its own — it just has to render inside whichever one
 * its caller supplies.
 *
 * Children render through `ToolCard`/`PermissionCard` directly — the same
 * pair `SubagentCard` itself uses for its inline window — rather than
 * through `TranscriptItemView`. `TranscriptItemView` offers a "Fork from
 * here" affordance on any idle-session `role: 'tool'` item, which posts
 * `fork-session` with the child's item id; but a subagent's children are
 * nested in `item.children[]`, never appended as top-level JSONL items, so
 * `TranscriptStore.upTo()` can never find that id and the fork silently
 * produces nothing. Rendering the same way `SubagentCard` correctly does
 * keeps that dead control out of this pane too.
 */
export function SubagentTranscript({
  item, sessionId, onBack, title,
}: {
  item: ToolItem;
  sessionId: SessionId;
  onBack: () => void;
  /** The pane's session title, shown in the breadcrumb. */
  title: string;
}) {
  const children = item.children ?? [];
  const model = item.tool.kind === 'subagent' ? item.tool.model : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-0.5 border-b border-border px-2 py-1 text-xs">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Back to ${title}`}
          onClick={onBack}
          className="h-6 w-fit gap-1 px-1 font-normal text-muted-foreground"
        >
          <ChevronLeftIcon aria-hidden className="size-3.5" />
          <span className="truncate">{title}</span>
        </Button>
        <span className="truncate px-1 font-medium">
          Subagent: {subagentLabel(item)}
          {model && <>{' · '}{model}</>}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <MessageScroller className="h-full">
          <MessageScrollerViewport className="px-2">
            <MessageScrollerContent className="justify-end gap-2">
              {children.map((child) => (
                <MessageScrollerItem key={child.id} messageId={child.id}>
                  {child.role === 'permission' ? (
                    <PermissionCard item={child} sessionId={sessionId} />
                  ) : child.role === 'tool' ? (
                    <ToolCard item={child} />
                  ) : null}
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </div>
    </div>
  );
}

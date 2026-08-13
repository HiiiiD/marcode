import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { evenlySizedPanes } from './pane-layout';
import { StatusBadge } from './status-badge';
import { useStore } from '../store';
import { folderName, formatTokens } from '../format';
import type { PaneState } from '../reducer';
import type { ModelInfo } from '../../protocol/messages';

interface SessionHeaderProps {
  pane: PaneState;
  models: ModelInfo[];
  /** The name this pane's title-derived controls (the close button) should
   * announce — the plain title, or the title plus the session id when
   * another visible pane shares it. See `accessibleTitles` in
   * `pane-layout.ts`. */
  accessibleTitle: string;
}

export function SessionHeader({ pane, models, accessibleTitle }: SessionHeaderProps) {
  const { state, post } = useStore();
  const s = pane.summary;
  const total = s.usage.inputTokens + s.usage.outputTokens;
  /**
   * The SDK fixes the model at query construction (see claude-provider.ts's
   * pendingModel), which happens lazily on the session's first send() — the
   * same "has a first message been sent yet" condition the composer's
   * bypass gate tracks, told from the same fact (pane.items is the
   * transcript; AgentSession.send() always appends a user item first).
   * Once that's true, a model change would be recorded but never take
   * effect on this run, so the control is disabled rather than silently
   * no-opping.
   */
  const hasStarted = pane.items.length > 0;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <StatusBadge status={s.status} />
      {/*
        `h2`, not `h1`: this panel is a view inside VS Code's own document,
        not a page with its own top-level heading. One per pane gives a
        keyboard/screen-reader user document structure to navigate the split
        by, where previously there were zero headings anywhere in the webview.
      */}
      <h2 className="truncate font-medium" title={s.title}>{s.title}</h2>
      <span className="truncate text-muted-foreground" title={s.cwd}>
        {folderName(s.cwd)}
      </span>
      {s.permissionMode === 'bypass' && (
        // Text, not a bare colored dot: a color alone would be invisible to
        // a colorblind user and meaningless to a new one. `role="status"`
        // exposes it to assistive tech even though it renders no live
        // announcement region elsewhere. Lives in the header (not just the
        // composer's Select) because the composer can scroll out of view
        // during a long turn while this header does not.
        <span
          role="status"
          className={cn(
            'shrink-0 rounded-full border border-destructive/40 bg-destructive/10',
            'px-1.5 py-0.5 text-[0.7rem] font-medium text-destructive dark:bg-destructive/20',
          )}
        >
          Bypassing permissions
        </span>
      )}
      <span className="ml-auto flex min-w-0 items-center text-muted-foreground">
        <Select
          items={models.map((m) => ({ value: m.id, label: m.displayName }))}
          value={s.model}
          onValueChange={(value) => post({ t: 'set-model', id: s.id, model: value as string })}
        >
          <SelectTrigger
            size="sm"
            className="h-auto min-w-0 shrink truncate border-0 bg-transparent p-0 text-muted-foreground"
            aria-label="Model"
            disabled={hasStarted}
            // Disabled-with-a-reason, not a silently-frozen label: matches
            // the composer's disabled bypass option and the roster picker's
            // disabled split-direction button. `aria-describedby` pointing
            // at real, rendered (if visually hidden) text — a `title` on a
            // disabled control is reachable by neither keyboard focus nor
            // most screen readers, since disabled elements are pulled out
            // of both.
            aria-describedby={hasStarted ? 'model-reason' : undefined}
          >
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.displayName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {hasStarted && (
          // sr-only rather than visible: the header has no room for a
          // sentence next to the status badge, title and cwd, and the
          // control is already visibly disabled.
          <span id="model-reason" className="sr-only">
            The model can only be chosen before the first message is sent.
          </span>
        )}
        {s.effort ? ` · ${s.effort}` : ''}
        {total > 0 && (
          <>
            {' · '}
            <span>{formatTokens(total)} tokens</span>
          </>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close session ${accessibleTitle}`}
        onClick={() => {
          // `close-session` alone only flips the session to archived on the
          // host and revokes its visibility (SessionManager.close) — it does
          // NOT touch the layout. Eligibility for a pane is roster
          // membership, not archived status (see pane-layout.ts), so
          // without also dropping this pane from the layout here, the pane
          // would keep rendering — now permanently patch-less, since the
          // host no longer considers it visible — until the user happened
          // to toggle it off/on in the roster picker or reload the window.
          // Post the layout change too, exactly like the roster picker's
          // uncheck does, so `paneIdsKey` changes and the app's
          // `set-visible` effect re-syncs the host.
          const remaining = state.layout.panes
            .map((p) => p.sessionId)
            .filter((id) => id !== s.id);
          post({ t: 'set-layout', layout: evenlySizedPanes(remaining, state.layout.orientation) });
          post({ t: 'close-session', id: s.id });
        }}
        className="shrink-0"
      >
        ×
      </Button>
    </div>
  );
}

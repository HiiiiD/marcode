import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";
import { folderName } from "../format";
import type { PaneState } from "../reducer";
import { useStore } from "../store";
import { evenlySizedPanes } from "./pane-layout";
import { StatusBadge } from "./status-badge";

interface SessionHeaderProps {
  pane: PaneState;
  /** The name this pane's title-derived controls (the close button) should
   * announce — the plain title, or the title plus the session id when
   * another visible pane shares it. See `accessibleTitles` in
   * `pane-layout.ts`. */
  accessibleTitle: string;
}

export function SessionHeader({ pane, accessibleTitle }: SessionHeaderProps) {
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
  // Session-scoped, not a bare literal: SessionHeader renders once per pane,
  // so a fixed id would collide across panes — `getElementById`, which is
  // what `aria-describedby` resolves against, returns only the first match,
  // and every other pane's disabled model control would describe itself
  // using pane one's reason text.
  const modelReasonId = `model-reason-${s.id}`;
  // Shown only when there's more than one provider to distinguish between —
  // with a single backend configured, naming it on every pane is noise.
  const providerLabel = state.catalog.find((p) => p.id === s.providerId)?.displayName;

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <StatusBadge status={s.status} />
      {/*
        `h2`, not `h1`: this panel is a view inside VS Code's own document,
        not a page with its own top-level heading. One per pane gives a
        keyboard/screen-reader user document structure to navigate the split
        by, where previously there were zero headings anywhere in the webview.
      */}
      <h2 className="truncate font-medium" title={s.title}>
        {s.title}
      </h2>
      <span className="truncate text-muted-foreground" title={s.cwd}>
        {folderName(s.cwd)}
      </span>
      {/*
        Text, not a bare colored dot: a color alone would be invisible to a
        colorblind user and meaningless to a new one. Lives in the header
        (not just the composer's Select) because the composer can scroll out
        of view during a long turn while this header does not.

        Rendered unconditionally (empty when not bypassing) rather than
        mounted only while `s.permissionMode === 'bypass'`: `role="status"`
        carries an implicit `aria-live="polite"`, and a live region that is
        created with its announcement text already inside it is typically
        not announced — the same reason Task 8 dropped this pattern from the
        roster count. Keeping the node mounted and only toggling its text
        content is what lets a screen reader actually hear the mode change.
      */}
      <span
        role="status"
        className={cn(
          "shrink-0 rounded-full text-[0.7rem] font-medium",
          s.permissionMode === "bypass" && [
            "border border-destructive/40 bg-destructive/10 px-1.5 py-0.5",
            "text-destructive dark:bg-destructive/20",
          ],
        )}
      >
        {s.permissionMode === "bypass" && "Bypassing permissions"}
      </span>
      <span className="ml-auto flex min-w-0 items-center text-muted-foreground">
        {hasStarted && (
          // sr-only rather than visible: the header has no room for a
          // sentence next to the status badge, title and cwd, and the
          // control is already visibly disabled.
          <span id={modelReasonId} className="sr-only">
            The model can only be chosen before the first message is sent.
          </span>
        )}
        {state.catalog.length > 1 && providerLabel && (
          <span className="text-muted-foreground">
            <span>&nbsp;</span>
            {/* <span>{` · ${providerLabel}`}</span> */}
            <span>{providerLabel}</span>
          </span>
        )}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Hide ${accessibleTitle} from the split`}
        onClick={() => {
          // Hide, not archive. This is the same operation as unchecking the
          // row in the roster, and posts the same message, so the two entry
          // points cannot drift. Archiving is a deliberate choice and lives
          // in the roster row's actions menu, under its own word.
          const remaining = state.layout.panes.map((p) => p.sessionId).filter((id) => id !== s.id);
          post({ t: "set-layout", layout: evenlySizedPanes(remaining, state.layout.orientation) });
        }}
        className="shrink-0"
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

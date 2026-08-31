import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MoreHorizontalIcon, XIcon } from "lucide-react";
import { folderName } from "../format";
import type { PaneState } from "../reducer";
import { useStore } from "../store";
import { ActiveSubagentBadge } from "./active-subagent-badge";
import { BringBackDialog } from "./bring-back-dialog";
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
  // Shown only when there's more than one provider to distinguish between —
  // with a single backend configured, naming it on every pane is noise.
  const providerLabel = state.catalog.find((p) => p.id === s.providerId)?.displayName;
  const [bringBackOpen, setBringBackOpen] = useState(false);

  // Asked once per directory, on mount and on every move. It is a read-only
  // git probe, and it is the only way the panel can know whether this session
  // is sitting in a linked worktree — nothing on `SessionState` says so, and
  // nothing should: it is a fact about the disk right now, not about the
  // session, and a persisted copy would describe a tree nobody has checked.
  const cwd = s.cwd;
  const id = s.id;
  useEffect(() => { post({ t: "request-bring-back", id }); }, [id, cwd, post]);

  // No door until the host has answered, and none at all when the answer is
  // "this is not a linked worktree" — an action that can only ever refuse is
  // worse than an absent one. Every other refusal keeps the door: those are
  // "not now", and the dialog is where the user reads why.
  const plan = state.bringBackBySession[id];
  const canBringBack = plan !== undefined && (plan.ok || plan.isWorktree);

  return (
    <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
      <StatusBadge status={s.status} />
      {/* Beside the status, not instead of it: "Working" says the session is
          busy, this says what with and takes you there. Absent whenever
          nothing is running, which is most of the time. */}
      <ActiveSubagentBadge items={pane.items} />
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
        {state.catalog.length > 1 && providerLabel && (
          <span className="text-muted-foreground">
            <span>&nbsp;</span>
            {/* <span>{` · ${providerLabel}`}</span> */}
            <span>{providerLabel}</span>
          </span>
        )}
      </span>
      {/*
        Mounted only when there is something in it. An overflow menu on every
        pane whose single item is absent nine times out of ten is a control
        that teaches the user it is empty; this one appears exactly when the
        session is in a worktree, which is also when it means something.
      */}
      {/*
        Mounted unconditionally, unlike the `canBringBack`-gated content
        inside it: Archive belongs here too, not only in the roster row's own
        menu, because a user acting from the pane has no reason to go find
        that session in the roster first. It posts the same `close-session`
        message that row does — same operation, second entry point, exactly
        how the pane's own Hide button already mirrors the roster's checkbox.
      */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-xs" className="shrink-0" />}
          // "Pane actions", not the roster row's own "More actions for
          // {title}": both mount at once when a session is both open in a
          // pane and visible in the roster picker, and identical labels
          // would leave `getByLabelText` unable to tell them apart.
          aria-label={`More pane actions for ${accessibleTitle}`}
        >
          <MoreHorizontalIcon aria-hidden />
        </DropdownMenuTrigger>
        {/* `w-auto`, overriding the menu's default `w-(--anchor-width)`:
            anchored to a 24px icon button, `min-w-32` is all that stops
            the item from being narrower than the phrase it has to be read
            by, and 128px still wraps it. Same fix as StaleTrees' row menu. */}
        <DropdownMenuContent className="w-auto">
          {canBringBack && (
            // The ellipsis is the promise that this opens a confirmation
            // rather than deleting a directory on the way up from the
            // click — the same contract the roster's `Delete…` keeps.
            <DropdownMenuItem onClick={() => setBringBackOpen(true)}>
              Bring branch back…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => post({ t: "close-session", id: s.id })}>
            Archive {accessibleTitle}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canBringBack && (
        <BringBackDialog pane={pane} open={bringBackOpen} onOpenChange={setBringBackOpen} />
      )}
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

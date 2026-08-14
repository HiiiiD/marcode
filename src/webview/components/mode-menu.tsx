import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FilePen, Hand, Map, ShieldBan, Zap, type LucideIcon } from "lucide-react";
import { useRef } from "react";
import type { EffortLevel, ModelInfo, PermissionMode } from "../../protocol/messages";
import type { PaneState } from "../reducer";
import { useStore } from "../store";

/**
 * One row per mode: a short label the trigger can wear at 300px, and a
 * sentence that says what the agent will actually be allowed to do. The
 * label alone never carried that — "deny" and "bypass" are opposites and
 * read as near-synonyms of "ask" to anyone who has not learned the set.
 */
const MODES: { value: PermissionMode; label: string; description: string; icon: LucideIcon }[] = [
  {
    value: "default",
    label: "Ask",
    description: "Approve every tool call before it runs.",
    icon: Hand,
  },
  {
    value: "acceptEdits",
    label: "Auto-edit",
    description: "File edits apply on their own. Everything else still asks.",
    icon: FilePen,
  },
  {
    value: "plan",
    label: "Plan",
    description: "Read and propose. Nothing on disk is changed.",
    icon: Map,
  },
  {
    value: "dontAsk",
    label: "Deny",
    description: "Refuse anything not already allowed, without prompting.",
    icon: ShieldBan,
  },
  {
    value: "bypass",
    label: "Bypass",
    description: "Run everything without asking. Chosen before the first message.",
    icon: Zap,
  },
];

const MODE_OF = (mode: PermissionMode) => MODES.find((m) => m.value === mode) ?? MODES[0];

/**
 * Effort as a scale you set in place, not a submenu you open: five levels
 * ordered low → max is a magnitude, and a magnitude is set faster by
 * pointing at a position than by opening a list and reading five words
 * ("xhigh" vs "max" carries no order in it).
 *
 * It is a menu ITEM, not a bare focusable div — the menu owns roving focus,
 * so anything that is not an item is unreachable by the arrow keys that got
 * the user here. `closeOnClick={false}` is what makes it a control rather
 * than a choice: dragging across the dots, or nudging with the arrow keys,
 * leaves the menu open so the result is visible while it changes.
 */
function EffortSlider({
  levels,
  value,
  onChange,
}: {
  levels: EffortLevel[];
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
}) {
  const track = useRef<HTMLSpanElement | null>(null);
  /**
   * The track's box as it was when the drag started. Measuring per move
   * would read the layout the CURRENT value produced, so any width change
   * downstream of the value moves the dots out from under a pointer that
   * never left the row. Sizing the readout to its widest level (below)
   * already stops that shift, but a drag is the one interaction that cannot
   * survive being wrong even once, and one measurement per gesture is also
   * simply cheaper than one per move.
   */
  const dragBox = useRef<DOMRect | null>(null);
  const active = levels.indexOf(value);

  const step = (delta: number) => {
    const next = levels[Math.min(levels.length - 1, Math.max(0, active + delta))];
    if (next && next !== value) {
      onChange(next);
    }
  };

  /**
   * Nearest dot to the pointer, from the track's own box — the dots are
   * evenly spaced, so index `i` sits at `i / (n - 1)` of the width and
   * rounding the ratio lands on the one being pointed at. Rounding rather
   * than flooring is also what makes the two ends forgiving: the outer half
   * of each end dot's cell snaps to it.
   */
  const setFromX = (clientX: number) => {
    const box = dragBox.current ?? track.current?.getBoundingClientRect();
    if (!box || box.width === 0) {
      return;
    }
    const ratio = (clientX - box.left) / box.width;
    const i = Math.min(levels.length - 1, Math.max(0, Math.round(ratio * (levels.length - 1))));
    if (levels[i] !== value) {
      onChange(levels[i]);
    }
  };

  return (
    <DropdownMenuItem
      closeOnClick={false}
      className="gap-3 py-1.5"
      // The accessible name carries the value because this is a menu item,
      // not a real `role="slider"` — Base UI owns the item's role, and a
      // control that announces "Effort" alone would leave a screen-reader
      // user arrowing blind.
      aria-label={`Effort: ${value}. Left and right arrows change it.`}
      onKeyDown={(e) => {
        const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (delta !== 0) {
          // The menu is vertical, so it has no use for left/right of its
          // own — but stop it reaching the popup anyway rather than relying
          // on that, since ArrowLeft closes a submenu one level up.
          e.preventDefault();
          e.stopPropagation();
          step(delta);
          return;
        }
        if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          e.stopPropagation();
          const end = e.key === "Home" ? levels[0] : levels[levels.length - 1];
          if (end !== value) {
            onChange(end);
          }
        }
      }}
    >
      <span>Effort</span>
      <span
        ref={track}
        // py-2 for the hit area, not for the look: the dots themselves are
        // 8px, which is a target no one can hit in a sidebar.
        className="ml-auto flex cursor-pointer items-center gap-1.5 py-2"
        onPointerDown={(e) => {
          dragBox.current = e.currentTarget.getBoundingClientRect();
          e.currentTarget.setPointerCapture(e.pointerId);
          setFromX(e.clientX);
        }}
        onPointerMove={(e) => {
          // buttons is a bitmask of what is held down; 1 is the primary
          // button. Without it every hover over the track would set a level.
          if (e.buttons & 1) {
            setFromX(e.clientX);
          }
        }}
        onPointerUp={() => {
          dragBox.current = null;
        }}
        // Capture is released for us when the pointer is lost, but the
        // cached box has to go with it — a stale one would survive into the
        // next gesture and be measured against a row that has since moved.
        onPointerCancel={() => {
          dragBox.current = null;
        }}
        aria-hidden
      >
        {levels.map((level, i) => (
          <span
            key={level}
            className={cn(
              "size-2 rounded-full transition-colors",
              i <= active ? "bg-foreground" : "bg-foreground/20",
              i === active && "ring-2 ring-foreground/30",
            )}
          />
        ))}
      </span>
      {/*
        Every level stacked in ONE grid cell, with the inactive ones merely
        invisible: the box is then exactly as wide as this model's widest
        name, measured by the browser in the real font. It has to be
        reserved rather than fitted — the readout follows an `ml-auto`
        track, so a value that renders wider than the last one drags the
        dots leftward out from under the pointer that is setting them, which
        is why high → medium jumped.

        Reserved by measurement, not by arithmetic: `ch` is the advance of
        "0", so `6ch` is not the width of "medium" in a proportional face,
        and the levels come from the provider's catalog row anyway — a model
        can ship any names, in any number, at any length.
      */}
      <span className="grid justify-items-end">
        {levels.map((level) => (
          <span
            key={level}
            aria-hidden={level !== value}
            className={cn(
              "col-start-1 row-start-1 text-xs text-muted-foreground",
              level !== value && "invisible",
            )}
          >
            {level}
          </span>
        ))}
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Permission mode and effort in one control. They were two triggers side by
 * side, which spent a third of a 300px composer row on two words of jargon
 * and still left the modes unexplained. One trigger names the mode the
 * session is actually in; the menu explains the alternatives and parks
 * effort — the rarer of the two settings — one level down, where it still
 * shows its current level without being opened.
 */
export function ModeMenu({ pane, model }: { pane: PaneState; model: ModelInfo | undefined }) {
  const { post } = useStore();
  const mode = MODE_OF(pane.summary.permissionMode);
  const bypassing = pane.summary.permissionMode === "bypass";
  /**
   * The Claude provider can only honor 'bypass' at query construction —
   * which happens lazily, on the session's first send() — so this must
   * track the same "has a first message been sent yet" condition the
   * provider itself uses. `pane.items` is the session's transcript, and
   * AgentSession.send() always appends a user item before ever calling the
   * provider, so "any items" and "sent the first message" are the same fact
   * told from two sides of the wire.
   */
  const hasStarted = pane.items.length > 0;
  // Session-scoped, not a bare literal: one ModeMenu renders per pane, so a
  // fixed id would collide across panes — `getElementById`, which is what
  // `aria-describedby` resolves against, returns only the first match, and
  // every other pane's disabled bypass option would describe itself using
  // pane one's reason text.
  const bypassReasonId = `bypass-reason-${pane.summary.id}`;

  const effort = model?.effort;
  /**
   * The session's level, but only if this model's scale actually has it:
   * levels and their names come from the provider's catalog row, so a
   * session switched onto another model can be carrying a level that no
   * longer exists. Falling back to the model's own default keeps the scale
   * showing a position it can render instead of an empty one.
   */
  const saved = pane.summary.effort;
  const level = saved && effort?.levels.includes(saved) ? saved : effort?.default;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Permission mode"
        title={`Permission mode: ${mode.label}`}
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              "min-w-0",
              // The one place in the composer where color carries meaning:
              // bypass is the only mode that can run a destructive tool
              // without a prompt, so the trigger stops reading as neutral
              // chrome the moment the session is in it.
              bypassing &&
                "border-destructive text-destructive hover:text-destructive dark:border-destructive/50",
            )}
          />
        }
      >
        <mode.icon className={cn(!bypassing && "text-muted-foreground")} />
        <span className="truncate">{mode.label}</span>
      </DropdownMenuTrigger>
      {/* The popup defaults to the trigger's width, and this trigger is two
          words wide — the descriptions need the room the pane has instead,
          floored at the trigger and capped at what is actually available. */}
      <DropdownMenuContent className="w-auto min-w-(--anchor-width) max-w-(--available-width)">
        <DropdownMenuRadioGroup
          value={pane.summary.permissionMode}
          onValueChange={(value) =>
            post({ t: "set-permission-mode", id: pane.summary.id, mode: value as PermissionMode })
          }
        >
          <DropdownMenuLabel>Permission mode</DropdownMenuLabel>
          {MODES.map((m) => {
            const disableBypass = m.value === "bypass" && hasStarted;
            return (
              <DropdownMenuRadioItem
                key={m.value}
                value={m.value}
                disabled={disableBypass}
                // Disabled-with-a-reason, not a silently-absent option — a
                // user who used bypass earlier in this same session should
                // be able to tell why it is greyed out now rather than
                // wonder if it vanished. `aria-describedby` pointing at
                // real, rendered text rather than a `title`: a title on a
                // disabled control is reachable by neither keyboard focus
                // nor most screen readers, since disabled elements are
                // pulled out of both.
                aria-describedby={disableBypass ? bypassReasonId : undefined}
                className="items-start gap-2 py-1.5"
              >
                <m.icon className="mt-0.5 text-muted-foreground" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{m.description}</span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {hasStarted && (
          <p id={bypassReasonId} className="px-1.5 py-1 text-[0.65rem] text-muted-foreground">
            Bypass can only be chosen before the first message is sent.
          </p>
        )}
        {effort && level && effort.levels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <EffortSlider
              levels={effort.levels}
              value={level}
              onChange={(next) => post({ t: "set-effort", id: pane.summary.id, effort: next })}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

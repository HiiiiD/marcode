import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ModelInfo, PermissionMode } from "../../protocol/messages";
import type { PaneState } from "../reducer";
import { useStore } from "../store";
import { EffortSlider } from "./effort-slider";
import { MODE_OF, modeRowsForProvider } from "./permission-modes";

/**
 * Permission mode and effort in one control. They were two triggers side by
 * side, which spent a third of a 300px composer row on two words of jargon
 * and still left the modes unexplained. One trigger names the mode the
 * session is actually in; the menu explains the alternatives and parks
 * effort — the rarer of the two settings — one level down, where it still
 * shows its current level without being opened.
 */
export function ModeMenu({
  pane,
  model,
  disabled,
}: {
  pane: PaneState;
  model: ModelInfo | undefined;
  /** The session's provider is unavailable: nothing set here could be honored. */
  disabled?: boolean;
}) {
  const { post, state } = useStore();
  const provider = state.catalog.find((p) => p.id === pane.summary.providerId);
  const rows = modeRowsForProvider(pane.summary.providerId, provider?.permissionModes);
  const mode = rows.find((row) => row.value === pane.summary.permissionMode) ?? MODE_OF(pane.summary.permissionMode);
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
            variant="ghost"
            size="sm"
            disabled={disabled}
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
        {/* Icon only in a small container; the title and menu still name the mode. */}
        <span className={cn("truncate", !bypassing && "hidden @[24rem]:inline")}>{mode.label}</span>
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
          {rows.map((m) => {
            const disableBypass = m.value === "bypass" && hasStarted;
            return (
              <DropdownMenuRadioItem
                key={m.value}
                value={m.value}
                disabled={disableBypass}
                className="items-start gap-2 py-1"
              >
                <m.icon className="mt-0.5 text-muted-foreground" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {disableBypass ? "Only before the first message" : m.description}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {effort && level && effort.levels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
            <DropdownMenuLabel>Effort</DropdownMenuLabel>
            <EffortSlider
              labelled={false}
              levels={effort.levels}
              value={level}
              onChange={(next) => post({ t: "set-effort", id: pane.summary.id, effort: next })}
              // `closeOnClick={false}` is what makes it a control rather than
              // a choice: dragging across the dots, or nudging with the arrow
              // keys, leaves the menu open so the result is visible while it
              // changes.
              render={(props) => (
                <DropdownMenuItem closeOnClick={false} className="gap-3 py-1" {...props} />
              )}
            />
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

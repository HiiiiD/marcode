import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { useId } from "react";
import type { EffortLevel, ModelInfo, PermissionMode } from "../../protocol/messages";
import { EffortSlider } from "./effort-slider";
import type { ModeRow } from "./permission-modes";

/** Step 2: how hard the model thinks and what it may do without asking. */
export function SettingsStep({
  scale, level, onEffort, rows, mode, onMode,
}: {
  scale: ModelInfo["effort"];
  level: EffortLevel | undefined;
  onEffort: (level: EffortLevel) => void;
  rows: ModeRow[];
  mode: PermissionMode;
  onMode: (mode: PermissionMode) => void;
}) {
  // Per instance: the roster and the empty state each render a create control, so a fixed id could be claimed twice.
  const ids = useId();

  return (
    <div className="flex h-full flex-col justify-center gap-6">
      {scale && level && scale.levels.length > 0 && (
        <div className="flex flex-col gap-1">
        <p className="text-xs font-medium text-muted-foreground">Effort</p>
        <EffortSlider
          levels={scale.levels}
          value={level}
          onChange={onEffort}
          // Focusable in its own right: no menu owns roving focus in a dialog, so the arrow keys it listens for
          // can only reach the row if Tab does.
          render={(props) => (
            <div
              tabIndex={0}
              className={cn("flex items-center gap-3 rounded-md px-1.5 outline-none", "focus-visible:ring-3 focus-visible:ring-ring/50")}
              {...props}
            />
          )}
        />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Permission mode</p>
        <RadioGroup value={mode} onValueChange={(v) => onMode(v as PermissionMode)}>
          {rows.map((m) => (
            <div key={m.value} className={cn("flex flex-col rounded-md px-1.5 py-1", "hover:bg-accent hover:text-accent-foreground")}>
              {/* The sentence is a description, not part of the name: a radio announcing itself as "Plan Read and
                  propose…" buries the one word being chosen between. */}
              <label className="flex cursor-pointer items-center gap-2 font-medium">
                <RadioGroupItem value={m.value} aria-describedby={`${ids}-${m.value}`} />
                <m.icon className="size-3.5 text-muted-foreground" aria-hidden />
                {m.label}
              </label>
              <span id={`${ids}-${m.value}`} className="pl-6 text-xs leading-snug text-muted-foreground">
                {m.description}
              </span>
            </div>
          ))}
        </RadioGroup>
      </div>
    </div>
  );
}

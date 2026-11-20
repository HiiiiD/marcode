import { Button } from "@/components/ui/button";
import { recentCombos, type RecentCombo } from "../../client-core/create-recents";
import type { ProviderInfo, SessionSummary } from "../../protocol/messages";
import { expandedDisplayName, findModel } from "../../shared/model-catalog";
import { modeRowsForProvider } from "./permission-modes";

export function comboLabel(combo: RecentCombo, catalog: ProviderInfo[]): string {
  const provider = catalog.find((p) => p.id === combo.providerId);
  const model = provider ? findModel(provider.models, combo.model) : undefined;
  const mode = modeRowsForProvider(provider?.id, provider?.permissionModes).find((m) => m.value === combo.mode);
  return [model ? expandedDisplayName(model) : combo.model, combo.effort, mode?.label ?? combo.mode].filter(Boolean).join(" · ");
}

/** One click for a model + effort + mode you have recently used: the common case needs no stepping at all. */
export function RecentCombos({
  sessions, catalog, onPick,
}: {
  sessions: readonly SessionSummary[];
  catalog: ProviderInfo[];
  onPick: (combo: RecentCombo) => void;
}) {
  const combos = recentCombos(sessions, catalog);
  if (combos.length === 0) { return null; }

  return (
    <section aria-label="Recent settings" className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">Recent</p>
      <div className="flex flex-col">
        {combos.map((combo) => {
          const label = comboLabel(combo, catalog);
          return (
            <Button
              key={label + combo.providerId}
              type="button"
              variant="ghost"
              size="sm"
              title={label}
              className="w-full min-w-0 justify-start px-1.5 font-normal text-muted-foreground hover:text-foreground"
              onClick={() => onPick(combo)}
            >
              <span className="truncate">{label}</span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

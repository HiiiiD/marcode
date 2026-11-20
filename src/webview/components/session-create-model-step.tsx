import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Star } from "lucide-react";
import { useState } from "react";
import type { ModelInfo, ProviderInfo } from "../../protocol/messages";
import { expandedDisplayName, isFavorite, modelKey } from "../../shared/model-catalog";
import { useStore } from "../store";

/**
 * One radio value has to name a model *and* the provider it came from: two
 * providers can publish the same model id (an alias like `opus` is exactly
 * the kind of id that will collide), and this is one radio group so that
 * picking a model under one provider clears the pick under the other.
 *
 * Same key `shared/model-catalog.ts#modelKey` uses for a favorite-models
 * entry — not a coincidence, the collision it guards against is the same one.
 */
export const valueOf = modelKey;

function FavoriteToggle({ starred, name, onClick }: { starred: boolean; name: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="shrink-0"
      aria-label={starred ? `Unstar ${name}` : `Star ${name}`}
      onClick={onClick}
    >
      <Star className={cn("size-3.5", starred && "fill-current text-amber-500")} />
    </Button>
  );
}

/**
 * One model radio, shared by both tabs. `subtitle` is what makes the
 * Favorites tab's flat cross-provider list legible without a group heading —
 * the All tab already says the provider via its own group header, so it
 * leaves this unset.
 */
function ModelRow({
  model, value, starred, onToggleFavorite, subtitle,
}: {
  model: ModelInfo;
  value: string;
  starred: boolean;
  onToggleFavorite: () => void;
  subtitle?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-md pr-1", "hover:bg-accent hover:text-accent-foreground")}>
      {/* The subtitle sits OUTSIDE the <label>: the radio's accessible name comes from the label, and a provider
          subtitle inside it would announce as "Other One Other" and break every name match. */}
      <div className="flex min-w-0 flex-1 flex-col px-1.5 py-1">
        <label className="flex min-w-0 cursor-pointer items-center gap-2">
          <RadioGroupItem value={value} />
          <span className="min-w-0 truncate">{expandedDisplayName(model)}</span>
        </label>
        {subtitle && <span className="min-w-0 truncate pl-6 text-[0.65rem] text-muted-foreground">{subtitle}</span>}
      </div>
      <FavoriteToggle starred={starred} name={expandedDisplayName(model)} onClick={onToggleFavorite} />
    </div>
  );
}

/** Step 1: which provider and model, searchable, with favourites first. */
export function ModelStep({
  catalog, picked, onPick,
}: {
  catalog: ProviderInfo[];
  picked: string;
  onPick: (value: string) => void;
}) {
  const { state, post } = useStore();
  const [search, setSearch] = useState("");
  const named = catalog.length > 1;

  const starred = (providerId: string, modelId: string) => isFavorite(providerId, modelId, state.favoriteModels);
  const toggleFavorite = (providerId: string, modelId: string) => {
    const key = modelKey(providerId, modelId);
    const ids = starred(providerId, modelId)
      ? state.favoriteModels.filter((id) => id !== key)
      : [...state.favoriteModels, key];
    post({ t: "set-favorite-models", ids });
  };

  // From the full catalog, not the search-narrowed groups, so favourites survive a search typed on the All tab.
  const allFavorites = catalog.flatMap((p) => p.models.filter((m) => starred(p.id, m.id)).map((m) => ({ provider: p, model: m })));
  // Chosen once per mount: switching tabs under someone mid-search would be worse than opening on the wrong one.
  const [tab, setTab] = useState<"favorites" | "all">(allFavorites.length > 0 ? "favorites" : "all");

  const query = search.trim().toLowerCase();
  const favorites = allFavorites.filter((e) => e.model.displayName.toLowerCase().includes(query));
  const groups = catalog
    .map((p) => ({ provider: p, models: p.models.filter((m) => m.displayName.toLowerCase().includes(query)) }))
    .filter((g) => g.models.length > 0);

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search models…"
        aria-label="Search models"
        className="h-7 text-xs"
      />
      <RadioGroup aria-label="Model" value={picked} onValueChange={(v) => onPick(String(v))}>
        {/* A grid item's default min-width is `auto`, the same shrink-blocking trap as a flex item: without this a long
            model name widens the whole tab subtree and the scroll container clips the star off the edge. */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as "favorites" | "all")} className="min-w-0">
          <TabsList>
            <TabsTab value="favorites">Favorites</TabsTab>
            <TabsTab value="all">All</TabsTab>
            <TabsIndicator />
          </TabsList>

          <TabsPanel value="favorites" className="pt-2">
            {favorites.length === 0 ? (
              <div className="flex flex-col items-start gap-1 px-0.5 py-1 text-xs text-muted-foreground">
                <p>{allFavorites.length === 0 ? "No favorites yet." : `No favorites match "${search.trim()}".`}</p>
                {allFavorites.length === 0 && (
                  <Button type="button" variant="link" size="xs" className="h-auto p-0 text-xs" onClick={() => setTab("all")}>
                    Browse all models to star the ones you use
                  </Button>
                )}
              </div>
            ) : (
              favorites.map(({ provider: p, model: m }) => (
                <ModelRow
                  key={modelKey(p.id, m.id)}
                  model={m}
                  subtitle={named ? p.displayName : undefined}
                  value={valueOf(p.id, m.id)}
                  starred
                  onToggleFavorite={() => toggleFavorite(p.id, m.id)}
                />
              ))
            )}
          </TabsPanel>

          <TabsPanel value="all" className="pt-2">
            {groups.length === 0 && <p className="px-0.5 py-1 text-xs text-muted-foreground">No models match "{search.trim()}".</p>}
            <div className="flex min-w-0 flex-col gap-2">
              {groups.map(({ provider: p, models }) => (
                <div key={p.id} role="group" aria-label={p.displayName} className="flex min-w-0 flex-col gap-1">
                  {named && (
                    <p className="px-0.5 text-xs text-muted-foreground">{p.displayName}</p>
                  )}
                  {models.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      value={valueOf(p.id, m.id)}
                      starred={starred(p.id, m.id)}
                      onToggleFavorite={() => toggleFavorite(p.id, m.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </TabsPanel>
        </Tabs>
      </RadioGroup>
    </div>
  );
}

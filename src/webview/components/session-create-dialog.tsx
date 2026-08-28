import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Star } from "lucide-react";
import { useId, useState } from "react";
import type { EffortLevel, ModelInfo, PermissionMode, ProviderInfo } from "../../protocol/messages";
import { findModel, isFavorite, modelKey, resolveEffort } from "../../shared/model-catalog";
import { resolvePermissionMode } from "../../shared/permission-catalog";
import { useStore } from "../store";
import { EffortSlider } from "./effort-slider";
import { modesFor } from "./permission-modes";
import type { CreateSettings } from "./session-create-settings";

/**
 * One radio value has to name a model *and* the provider it came from: two
 * providers can publish the same model id (an alias like `opus` is exactly
 * the kind of id that will collide), and this is one radio group so that
 * picking a model under one provider clears the pick under the other.
 *
 * Same key `shared/model-catalog.ts#modelKey` uses for a favorite-models
 * entry — not a coincidence, the collision it guards against is the same one.
 */
const valueOf = modelKey;

/** A star toggle shared by both tabs — filled when starred, outline otherwise. */
function FavoriteToggle({
  starred, name, onClick,
}: {
  starred: boolean;
  name: string;
  onClick: () => void;
}) {
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
      {/* The subtitle sits OUTSIDE the <label>, not nested inside it: this
          radio's accessible name comes from `aria-labelledby` pointing at
          the label's own id, which folds in every descendant text node — a
          provider subtitle inside it would announce as "Other One Other"
          instead of "Other One", and break every `getByRole(..., {name})`
          match along with it. */}
      <div className="flex min-w-0 flex-1 flex-col px-1.5 py-1">
        <label className="flex min-w-0 cursor-pointer items-center gap-2">
          <RadioGroupItem value={value} />
          <span className="min-w-0 truncate">{model.displayName}</span>
        </label>
        {subtitle && (
          <span className="min-w-0 truncate pl-6 text-[0.65rem] text-muted-foreground">{subtitle}</span>
        )}
      </div>
      <FavoriteToggle starred={starred} name={model.displayName} onClick={onToggleFavorite} />
    </div>
  );
}

/**
 * The full create form, for the session that is NOT like the one you are in.
 *
 * A dialog rather than a menu: three settings, one of which needs a sentence
 * of explanation per option, do not fit a popup anchored in a 300px sidebar
 * — and unlike `+ New` this path is deliberate, so it can afford a modal
 * that takes the panel and hands focus back on close.
 */
export function SessionCreateDialog({
  open,
  onOpenChange,
  catalog,
  initial,
  seedable,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: ProviderInfo[];
  /** What `+ New` would have created. The form opens on it. */
  initial: CreateSettings;
  /** True for the handoff dialog: adds the first-message field and relabels. */
  seedable?: boolean;
  onCreate: (settings: CreateSettings, seed?: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Flex column, not the default grid, so the scroll lives on the form's
          body alone: a dialog that scrolls as one unit takes Create and Cancel
          off screen with it, and the model list is long enough in a 300px
          sidebar that they always are. */}
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>{seedable ? "Hand off to a new session" : "New session"}</DialogTitle>
        </DialogHeader>
        {/* Keyed on the settings it opens with, so reopening starts from
            whatever `+ New` would do NOW rather than from the edits of
            whoever opened it last. */}
        {open && (
          <CreateForm
            key={valueOf(initial.providerId, initial.model) + initial.mode}
            catalog={catalog}
            initial={initial}
            seedable={seedable}
            onCreate={onCreate}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({
  catalog,
  initial,
  seedable,
  onCreate,
}: {
  catalog: ProviderInfo[];
  initial: CreateSettings;
  seedable?: boolean;
  onCreate: (settings: CreateSettings, seed?: string) => void;
}) {
  const { state, post } = useStore();
  const [picked, setPicked] = useState(valueOf(initial.providerId, initial.model));
  const [mode, setMode] = useState<PermissionMode>(initial.mode);
  const [seedText, setSeedText] = useState("");
  /** Filters the model rows below as the user types. Local — search position
   * is not something a reload needs to remember. */
  const [modelSearch, setModelSearch] = useState("");
  /**
   * `null` means "whatever this model's default is", which is what a freshly
   * picked model has to mean: effort levels belong to the model, so a level
   * chosen against the previous one is not a choice about this one.
   */
  const [effort, setEffort] = useState<EffortLevel | null>(initial.effort ?? null);
  // Per instance: the roster and the empty state each render a create
  // control, so a fixed id could be claimed twice and `aria-describedby`
  // (which resolves through getElementById) would follow the first match.
  const ids = useId();

  const [providerId, modelId] = picked.split(" ");
  const provider = catalog.find((p) => p.id === providerId) ?? catalog[0];
  const model = findModel(provider?.models ?? [], modelId) ?? provider?.models[0];
  const scale = model?.effort;
  const level = resolveEffort(model, effort ?? undefined);
  const rows = modesFor(provider?.permissionModes);
  // Derived, not stored — the same shape as `level` above, and for the same
  // reason: a mode belongs to the provider, so one chosen against a previous
  // provider is not a choice about this one. Switching the model radio from
  // Claude to Codex used to re-filter these rows with `mode` still on
  // `acceptEdits`, leaving nothing selected and Create posting a mode Codex
  // does not offer. The host resolves this too (`SessionManager.create`);
  // doing it here as well is what keeps the radio's selection honest.
  const effectiveMode = resolvePermissionMode(provider?.permissionModes ?? [], mode);

  // More than one provider is the only case where naming them earns its
  // vertical space — with one, every group header would say the same word.
  const named = catalog.length > 1;

  const starred = (providerId2: string, modelId2: string) =>
    isFavorite(providerId2, modelId2, state.favoriteModels);

  const toggleFavorite = (providerId2: string, modelId2: string) => {
    const key = modelKey(providerId2, modelId2);
    const ids = starred(providerId2, modelId2)
      ? state.favoriteModels.filter((id) => id !== key)
      : [...state.favoriteModels, key];
    post({ t: "set-favorite-models", ids });
  };

  // Every entry across every provider that is starred — flat, because the
  // Favorites tab exists specifically so a handful of models chosen out of a
  // catalog running to hundreds (OpenCode via OpenRouter) never needs a
  // provider heading to scan past. Computed from the full catalog, not
  // `groups` below, so it survives the search box narrowing the All tab.
  const allFavoriteEntries = catalog.flatMap((p) => (
    p.models
      .filter((m) => starred(p.id, m.id))
      .map((m) => ({ provider: p, model: m }))
  ));

  /**
   * Which tab opens first. Computed once per mount (this form remounts via
   * the dialog's `key` on every open) rather than reacting to
   * `favoriteModels` afterward — switching tabs under someone mid-search
   * would be worse than opening on the wrong one a moment before they can
   * see it. Nothing starred yet means Favorites would just be the empty
   * state, so first-run opens on the browsable list instead.
   */
  const [modelTab, setModelTab] = useState<"favorites" | "all">(
    allFavoriteEntries.length > 0 ? "favorites" : "all",
  );

  const query = modelSearch.trim().toLowerCase();
  const favoriteEntries = allFavoriteEntries.filter(
    (e) => e.model.displayName.toLowerCase().includes(query),
  );
  const groups = catalog
    .map((p) => ({ provider: p, models: p.models.filter((m) => m.displayName.toLowerCase().includes(query)) }))
    .filter((g) => g.models.length > 0);

  return (
    <>
      {/* `min-h-0` or the flex item refuses to shrink below its content and
          the popup grows past `max-h` instead of scrolling here. The negative
          margins put the scrollbar on the popup's edge rather than inside its
          padding. */}
      <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4">
        {seedable && (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${ids}-seed`} className="text-xs font-medium text-muted-foreground">
              First message
            </label>
            <Textarea
              id={`${ids}-seed`}
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              placeholder="Execute the plan in docs/superpowers/plans/…"
              className="min-h-16"
            />
          </div>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Model</p>
          <Input
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder="Search models…"
            className="h-7 text-xs"
          />
          <RadioGroup value={picked} onValueChange={(v) => { setPicked(String(v)); setEffort(null); }}>
            <Tabs value={modelTab} onValueChange={(v) => setModelTab(v as "favorites" | "all")}>
              <TabsList>
                <TabsTab value="favorites">Favorites</TabsTab>
                <TabsTab value="all">All</TabsTab>
                <TabsIndicator />
              </TabsList>

              <TabsPanel value="favorites" className="pt-2">
                {favoriteEntries.length === 0 ? (
                  <div className="flex flex-col items-start gap-1 px-0.5 py-1 text-xs text-muted-foreground">
                    <p>
                      {allFavoriteEntries.length === 0
                        ? "No favorites yet."
                        : `No favorites match "${modelSearch.trim()}".`}
                    </p>
                    {allFavoriteEntries.length === 0 && (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        className="h-auto p-0 text-xs"
                        onClick={() => setModelTab("all")}
                      >
                        Browse all models to star the ones you use
                      </Button>
                    )}
                  </div>
                ) : (
                  favoriteEntries.map(({ provider: p, model: m }) => (
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
                {groups.length === 0 && (
                  <p className="px-0.5 py-1 text-xs text-muted-foreground">
                    No models match "{modelSearch.trim()}".
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {groups.map(({ provider: p, models }) => (
                    <div
                      key={p.id} role="group" aria-label={p.displayName}
                      className="flex min-w-0 flex-col gap-1"
                    >
                      {named && (
                        <p className="px-0.5 text-[0.65rem] tracking-wide text-muted-foreground uppercase">
                          {p.displayName}
                        </p>
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

        {scale && level && scale.levels.length > 0 && (
          <EffortSlider
            levels={scale.levels}
            value={level}
            onChange={setEffort}
            // Focusable in its own right here: no menu owns roving focus in a
            // dialog, so the row has to be reachable by Tab or the arrow keys
            // it listens for can never be delivered to it.
            render={(props) => (
              <div
                tabIndex={0}
                className={cn(
                  "flex items-center gap-3 rounded-md px-1.5 outline-none",
                  "focus-visible:ring-3 focus-visible:ring-ring/50",
                )}
                {...props}
              />
            )}
          />
        )}

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">Permission mode</p>
          <RadioGroup value={effectiveMode} onValueChange={(v) => setMode(v as PermissionMode)}>
            {rows.map((m) => (
              <div
                key={m.value}
                className={cn(
                  "flex flex-col gap-0.5 rounded-md px-1.5 py-1.5",
                  "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {/* The sentence is a description, not part of the name: a
                    radio announcing itself as "Plan Read and propose. Nothing
                    on disk is changed." buries the one word being chosen
                    between. `aria-describedby` says it after the name. */}
                <label className="flex cursor-pointer items-center gap-2 font-medium">
                  <RadioGroupItem value={m.value} aria-describedby={`${ids}-${m.value}`} />
                  <m.icon className="size-3.5 text-muted-foreground" aria-hidden />
                  {m.label}
                </label>
                <span
                  id={`${ids}-${m.value}`}
                  className="pl-6 text-xs leading-snug text-muted-foreground"
                >
                  {m.description}
                </span>
              </div>
            ))}
          </RadioGroup>
        </div>
      </div>

      <DialogFooter className="shrink-0">
        <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
        <Button
          size="sm"
          disabled={!provider || !model || (seedable && !seedText.trim())}
          onClick={() => {
            if (!provider || !model) { return; }
            onCreate({
              providerId: provider.id,
              model: model.id,
              ...(level ? { effort: level } : {}),
              mode: effectiveMode,
            }, seedable ? seedText.trim() : undefined);
          }}
        >
          {seedable ? "Create and send" : "Create session"}
        </Button>
      </DialogFooter>
    </>
  );
}

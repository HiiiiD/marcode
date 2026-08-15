import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useId, useState } from "react";
import type { EffortLevel, PermissionMode, ProviderInfo } from "../../protocol/messages";
import { findModel, resolveEffort } from "../../shared/model-catalog";
import { resolvePermissionMode } from "../../shared/permission-catalog";
import { EffortSlider } from "./effort-slider";
import { modesFor } from "./permission-modes";
import type { CreateSettings } from "./session-create-settings";

/**
 * One radio value has to name a model *and* the provider it came from: two
 * providers can publish the same model id (an alias like `opus` is exactly
 * the kind of id that will collide), and this is one radio group so that
 * picking a model under one provider clears the pick under the other.
 */
const valueOf = (providerId: string, modelId: string) => `${providerId} ${modelId}`;

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
  const [picked, setPicked] = useState(valueOf(initial.providerId, initial.model));
  const [mode, setMode] = useState<PermissionMode>(initial.mode);
  const [seedText, setSeedText] = useState("");
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

  return (
    <>
      {/* `min-h-0` or the flex item refuses to shrink below its content and
          the popup grows past `max-h` instead of scrolling here. The negative
          margins put the scrollbar on the popup's edge rather than inside its
          padding. */}
      <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4">
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
          <RadioGroup value={picked} onValueChange={(v) => { setPicked(String(v)); setEffort(null); }}>
            {catalog.map((p) => (
              <div key={p.id} role="group" aria-label={p.displayName} className="flex flex-col gap-1">
                {named && (
                  <p className="px-0.5 text-[0.65rem] tracking-wide text-muted-foreground uppercase">
                    {p.displayName}
                  </p>
                )}
                {p.models.map((m) => (
                  <label
                    key={m.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5",
                      "hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    <RadioGroupItem value={valueOf(p.id, m.id)} />
                    <span className="min-w-0 truncate">{m.displayName}</span>
                  </label>
                ))}
              </div>
            ))}
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

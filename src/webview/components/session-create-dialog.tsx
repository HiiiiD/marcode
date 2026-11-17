import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { RecentCombo } from "../../client-core/create-recents";
import type { EffortLevel, PermissionMode, ProviderInfo } from "../../protocol/messages";
import { findModel, resolveEffort } from "../../shared/model-catalog";
import { resolvePermissionMode } from "../../shared/permission-catalog";
import { useStore } from "../store";
import { modeRowsForProvider } from "./permission-modes";
import { comboLabel, RecentCombos } from "./session-create-recents";
import { ModelStep, valueOf } from "./session-create-model-step";
import { OptionsStep } from "./session-create-options-step";
import { SettingsStep } from "./session-create-settings-step";
import type { CreateSettings } from "./session-create-settings";

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
  initialSeed,
  busy,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: ProviderInfo[];
  /** What `+ New` would have created. The form opens on it. */
  initial: CreateSettings;
  /** True for the handoff dialog: adds the first-message field and relabels. */
  seedable?: boolean;
  /** Prefills the first-message field each time the dialog opens. */
  initialSeed?: string;
  /** A handoff summary is in flight: the form is locked and the button says so. */
  busy?: boolean;
  onCreate: (
    settings: CreateSettings, seed?: string, worktree?: { branch: string; base?: string },
    includeSummary?: boolean,
  ) => void;
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
            initialSeed={initialSeed}
            busy={busy}
            onCreate={onCreate}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

const STEPS = ["Model", "Effort & mode", "Options"] as const;

type CreateHandler = (
  settings: CreateSettings, seed?: string, worktree?: { branch: string; base?: string }, includeSummary?: boolean,
) => void;

function CreateForm({
  catalog, initial, seedable, initialSeed, busy, onCreate,
}: {
  catalog: ProviderInfo[];
  initial: CreateSettings;
  seedable?: boolean;
  initialSeed?: string;
  busy?: boolean;
  onCreate: CreateHandler;
}) {
  const { state } = useStore();
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState(valueOf(initial.providerId, initial.model));
  const [mode, setMode] = useState<PermissionMode>(initial.mode);
  const [effort, setEffort] = useState<EffortLevel | null>(initial.effort ?? null);
  const [seedText, setSeedText] = useState(initialSeed ?? "");
  const [includeSummary, setIncludeSummary] = useState(true);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");

  const [providerId, modelId] = picked.split(" ");
  const provider = catalog.find((p) => p.id === providerId) ?? catalog[0];
  const model = findModel(provider?.models ?? [], modelId) ?? provider?.models[0];
  // Effort and mode belong to the model and the provider, so a choice made against a previous one is not a choice
  // about this one: both are derived, never stored resolved. The host resolves them too; doing it here keeps the
  // controls honest.
  const level = resolveEffort(model, effort ?? undefined);
  const rows = modeRowsForProvider(provider?.id, provider?.permissionModes);
  const effectiveMode = resolvePermissionMode(provider?.permissionModes ?? [], mode);
  const inWorktree = branch.trim().length > 0;

  const settings = (): CreateSettings | undefined => (provider && model
    ? { providerId: provider.id, model: model.id, ...(level ? { effort: level } : {}), mode: effectiveMode }
    : undefined);
  const canCreate = Boolean(provider && model) && !busy && !(seedable && !seedText.trim() && !includeSummary);

  const create = () => {
    const chosen = settings();
    if (!chosen) { return; }
    onCreate(
      chosen, seedable ? seedText.trim() : undefined,
      inWorktree ? { branch: branch.trim(), ...(base.trim() ? { base: base.trim() } : {}) } : undefined,
      seedable ? includeSummary : undefined,
    );
  };

  const applyCombo = (combo: RecentCombo) => {
    // A plain new session is created at once: that is the point of a shortcut. A handoff still needs its first
    // message, so the shortcut only fills in the settings and moves on to the step that asks for it.
    if (!seedable) {
      onCreate({ providerId: combo.providerId, model: combo.model, ...(combo.effort ? { effort: combo.effort } : {}), mode: combo.mode });
      return;
    }
    setPicked(valueOf(combo.providerId, combo.model));
    setEffort(combo.effort ?? null);
    setMode(combo.mode);
    setStep(2);
  };

  const summaries = [
    model ? comboLabel({ providerId: provider.id, model: model.id, mode: effectiveMode }, catalog).split(" · ")[0] : "",
    [level, rows.find((r) => r.value === effectiveMode)?.label].filter(Boolean).join(" · "),
    inWorktree ? branch.trim() : "",
  ];

  return (
    <>
      <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-4">
        <RecentCombos sessions={state.sessions} catalog={catalog} onPick={applyCombo} />

        <ol aria-label="Steps" className="flex gap-1">
          {STEPS.map((label, i) => (
            <li key={label} className="min-w-0 flex-1">
              <button
                type="button"
                aria-current={i === step ? "step" : undefined}
                onClick={() => setStep(i)}
                className={cn(
                  "flex w-full min-w-0 flex-col gap-0.5 border-b-2 px-1 pt-1 pb-1.5 text-left text-xs outline-none",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  i === step ? "border-primary text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="font-medium">{i + 1} {label}</span>
                <span className="truncate text-[0.65rem] opacity-80">{summaries[i] || " "}</span>
              </button>
            </li>
          ))}
        </ol>

        {/* All three stay mounted so the search text, tab and typed values survive moving between steps. */}
        <div hidden={step !== 0}><ModelStep catalog={catalog} picked={picked} onPick={(v) => { setPicked(v); setEffort(null); }} /></div>
        <div hidden={step !== 1}>
          <SettingsStep scale={model?.effort} level={level} onEffort={setEffort} rows={rows} mode={effectiveMode} onMode={setMode} />
        </div>
        <div hidden={step !== 2}>
          <OptionsStep
            seedable={Boolean(seedable)} seedText={seedText} onSeedText={setSeedText}
            includeSummary={includeSummary} onIncludeSummary={setIncludeSummary}
            branch={branch} onBranch={setBranch} base={base} onBase={setBase}
          />
        </div>
      </div>

      <DialogFooter className="shrink-0 flex-row items-center justify-end">
        <DialogClose render={<Button variant="outline" size="sm" className="mr-auto" />}>Cancel</DialogClose>
        {step > 0 && <Button variant="outline" size="sm" onClick={() => setStep(step - 1)}>Back</Button>}
        {step < STEPS.length - 1 && <Button variant="outline" size="sm" onClick={() => setStep(step + 1)}>Next</Button>}
        <Button size="sm" disabled={!canCreate} onClick={create}>
          {busy ? (
            <>
              <LoaderCircle className="animate-spin" aria-hidden />
              Summarizing…
            </>
          ) : seedable ? "Create and send" : "Create session"}
        </Button>
      </DialogFooter>
    </>
  );
}

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { GitBranch } from "lucide-react";
import { useId } from "react";

/** Step 3: the optional extras — an isolated worktree, and for a handoff the first message. */
export function OptionsStep({
  seedable, seedText, onSeedText, includeSummary, onIncludeSummary, branch, onBranch, base, onBase,
}: {
  seedable: boolean;
  seedText: string;
  onSeedText: (v: string) => void;
  includeSummary: boolean;
  onIncludeSummary: (v: boolean) => void;
  branch: string;
  onBranch: (v: string) => void;
  base: string;
  onBase: (v: string) => void;
}) {
  const ids = useId();
  // Derived, not a toggle: a non-empty branch name IS the choice to use a worktree.
  const inWorktree = branch.trim().length > 0;

  return (
    <div className="flex flex-col gap-3">
      {seedable && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${ids}-seed`} className="text-xs font-medium text-muted-foreground">First message</label>
          <Textarea
            id={`${ids}-seed`}
            value={seedText}
            onChange={(e) => onSeedText(e.target.value)}
            placeholder="Execute the plan in docs/superpowers/plans/…"
            className="min-h-16"
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={includeSummary}
              onCheckedChange={(v) => onIncludeSummary(v === true)}
              aria-label="Include summary of this session"
            />
            Include summary of this session
          </label>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <GitBranch className="size-3.5" aria-hidden />
          Run in a new worktree
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-branch`} className="text-xs text-muted-foreground">Branch name</label>
          <Input
            id={`${ids}-branch`}
            value={branch}
            onChange={(e) => onBranch(e.target.value)}
            placeholder="Leave empty to run here, in this workspace"
            className="h-7 text-xs"
          />
        </div>
        {inWorktree && (
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-base`} className="text-xs text-muted-foreground">Base branch</label>
            <Input
              id={`${ids}-base`}
              value={base}
              onChange={(e) => onBase(e.target.value)}
              placeholder="current branch"
              className="h-7 text-xs"
            />
          </div>
        )}
      </div>
    </div>
  );
}

import { SquareTerminal } from "lucide-react";

export function ShellCue() {
  return (
    <div className="flex w-full items-center gap-2 rounded-sm bg-primary/15 px-2 py-1 text-xs text-foreground">
      <SquareTerminal className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 wrap-break-word">
        <span className="font-semibold text-primary">Shell mode</span>
        <span className="text-muted-foreground"> · Enter runs it here, nothing goes to the model</span>
      </span>
    </div>
  );
}

import { SquareTerminal } from "lucide-react";

export function ShellCue() {
  return (
    <div className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
      <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 wrap-break-word">Shell command: Enter runs it here, nothing goes to the model</span>
    </div>
  );
}

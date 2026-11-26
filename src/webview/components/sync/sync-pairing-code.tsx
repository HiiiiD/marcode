import { Button } from "@/components/ui/button";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { codeGroups, countdown } from "../../../client-core/sync/sync-format";
import type { SyncPairingView } from "../../../protocol/messages";

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), () => toast(`Could not copy the ${what.toLowerCase()}`));
}

/** The one prominent moment in the dialog: a code you read or paste on the other machine, and when it stops working. */
export function SyncPairingCode({ pairing, now, busy, onRenew }: {
  pairing: SyncPairingView;
  now: number;
  busy: boolean;
  onRenew: () => void;
}) {
  const left = countdown(pairing.expiresAt, now);
  const minutesLeft = Math.ceil((pairing.expiresAt - now) / 60_000);
  if (left === "") {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
        <span className="text-sm text-muted-foreground">Expired</span>
        <Button size="xs" variant="outline" disabled={busy} onClick={onRenew}>Make a new code</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-foreground/[0.03] p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="flex flex-wrap gap-x-1.5 gap-y-0.5 font-mono text-base tracking-wide text-foreground" aria-label={`Pairing code ${pairing.code}`}>
          {codeGroups(pairing.code).map((group, i) => <span key={i}>{group}</span>)}
        </p>
        <Button size="icon-xs" variant="ghost" aria-label="Copy code" onClick={() => copy(pairing.code, "Code")}>
          <CopyIcon aria-hidden />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Works once · expires in <span className="tabular-nums" aria-live="off">{left}</span>
        <span className="sr-only" aria-live="polite">{minutesLeft <= 1 ? "Less than a minute left" : `${minutesLeft} minutes left`}</span>
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded bg-foreground/[0.06] px-1.5 py-1 font-mono text-[11px] text-muted-foreground" title={pairing.joinCommand}>
          {pairing.joinCommand}
        </code>
        <Button size="icon-xs" variant="ghost" aria-label="Copy join command" onClick={() => copy(pairing.joinCommand, "Command")}>
          <CopyIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}

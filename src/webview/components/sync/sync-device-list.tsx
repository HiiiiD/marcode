import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ChevronRightIcon, MoreHorizontalIcon, UserXIcon } from "lucide-react";
import { useState } from "react";
import { lastSeen } from "../../../client-core/sync/sync-format";
import type { SyncDeviceView } from "../../../protocol/messages";
import { InlineConfirm } from "./inline-confirm";

function DeviceRow({ device, now, busy, onRevoke }: {
  device: SyncDeviceView;
  now: number;
  busy: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span title={device.name} className={cn("min-w-0 truncate text-sm", device.revoked && "text-muted-foreground line-through")}>
          {device.name}
        </span>
        {device.self && <span className="shrink-0 rounded-full bg-foreground/10 px-1.5 py-px text-[11px] text-muted-foreground">this device</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{lastSeen(device.lastSeenAt, now)}</span>
        {device.unfinishedRevoke ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onRevoke}>Finish revoking</Button>
        ) : !device.self && !device.revoked ? (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" aria-label={`More actions for ${device.name}`} />}>
              <MoreHorizontalIcon aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-36">
              <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
                <UserXIcon aria-hidden />
                Revoke…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {confirming && (
        <InlineConfirm
          text={`Revoke ${device.name}? It keeps what it already downloaded; anything synced from now on uses a key it never had.`}
          action="Revoke"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); onRevoke(); }}
        />
      )}
    </li>
  );
}

/** Active devices first; revoked ones fold away unless one still needs its revoke finished. */
export function SyncDeviceList({ devices, now, busy, onRevoke }: {
  devices: SyncDeviceView[];
  now: number;
  busy: boolean;
  onRevoke: (deviceId: string) => void;
}) {
  const [showRevoked, setShowRevoked] = useState(false);
  const shown = devices.filter((d) => !d.revoked || d.unfinishedRevoke);
  const folded = devices.filter((d) => d.revoked && !d.unfinishedRevoke);
  const row = (d: SyncDeviceView) => <DeviceRow key={d.deviceId} device={d} now={now} busy={busy} onRevoke={() => onRevoke(d.deviceId)} />;
  return (
    <div className="flex flex-col">
      <ul className="flex flex-col divide-y divide-border">{shown.map(row)}</ul>
      {folded.length > 0 && (
        <>
          <Button
            variant="bare"
            size={null}
            aria-expanded={showRevoked}
            onClick={() => setShowRevoked((v) => !v)}
            className="flex items-center gap-1 self-start rounded-md py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-transform", showRevoked && "rotate-90")} />
            {folded.length} revoked
          </Button>
          {showRevoked && <ul className="flex flex-col divide-y divide-border">{folded.map(row)}</ul>}
        </>
      )}
    </div>
  );
}

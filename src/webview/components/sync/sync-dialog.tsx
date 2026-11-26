import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hostOf } from "../../../client-core/sync/sync-format";
import type { SyncPanel } from "../../../protocol/messages";
import { useStore } from "../../store";
import { InlineConfirm } from "./inline-confirm";
import { SyncConnectForm } from "./sync-connect-form";
import { SyncDeviceList } from "./sync-device-list";
import { SyncPairingCode } from "./sync-pairing-code";
import { SyncProjects } from "./sync-projects";

type Paired = Extract<SyncPanel, { state: "paired" }>;

/** Ticks each second while a code is shown, plus once exactly at its deadline so expiry never lags. */
function useNow(deadline: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (deadline === undefined) { return; }
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const end = setTimeout(() => setNow(Date.now()), Math.max(0, deadline - Date.now() + 10));
    return () => { clearInterval(tick); clearTimeout(end); };
  }, [deadline]);
  return now;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="pt-1 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function StatusLine({ panel }: { panel: Paired }) {
  const { post } = useStore();
  const host = hostOf(panel.server);
  if (panel.connection === "unreachable") {
    return (
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-attention">Can't reach {host}</p>
        <Button size="xs" variant="ghost" disabled={panel.busy !== undefined} onClick={() => post({ t: "sync-refresh" })}>
          <RefreshCwIcon aria-hidden />
          Retry
        </Button>
      </div>
    );
  }
  const state = panel.connection === "checking" ? "Checking…" : "Connected";
  return <p className="truncate text-xs text-muted-foreground" title={panel.server}>{host} · {panel.deviceName} · {state}</p>;
}

function PairedBody({ panel }: { panel: Paired }) {
  const { post } = useStore();
  const [leaving, setLeaving] = useState(false);
  const now = useNow(panel.pairing?.expiresAt);
  const busy = panel.busy !== undefined;

  if (panel.connection === "revoked") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">This device was removed from sync on another device.</p>
        <Button size="sm" variant="outline" className="self-start" onClick={() => post({ t: "sync-forget" })}>Remove this device's sync data</Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
      <StatusLine panel={panel} />
      {panel.error && <p role="alert" className="text-xs text-destructive">{panel.error.message}</p>}
      <Section title="Devices">
        <div className={panel.connection === "unreachable" ? "opacity-60" : undefined}>
          <SyncDeviceList devices={panel.devices} now={now} busy={busy} onRevoke={(deviceId) => post({ t: "sync-revoke", deviceId })} />
        </div>
        {panel.pairing ? (
          <SyncPairingCode pairing={panel.pairing} now={now} busy={busy} onRenew={() => post({ t: "sync-pair" })} />
        ) : (
          <Button size="xs" variant="outline" className="self-start" disabled={busy || panel.connection !== "connected"} onClick={() => post({ t: "sync-pair" })}>
            <PlusIcon aria-hidden />
            Add a device
          </Button>
        )}
      </Section>
      <Separator />
      <Section title="Project memory">
        <SyncProjects projects={panel.projects} onChoose={(path, choice) => post({ t: "sync-project", path, choice })} />
      </Section>
      <Separator />
      {leaving ? (
        <InlineConfirm
          text="Leave sync? This device stops syncing and forgets its keys."
          action="Leave"
          busy={busy}
          onCancel={() => setLeaving(false)}
          onConfirm={() => { setLeaving(false); post({ t: "sync-leave" }); }}
        />
      ) : (
        <Button size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => setLeaving(true)}>Leave sync…</Button>
      )}
    </div>
  );
}

/** Panel-level: opened by `/sync`, the "Set up sync" command and the status chip; renders the host's `sync-panel`. */
export function SyncDialog() {
  const { state, post } = useStore();
  const [open, setOpen] = useState(false);
  const handled = useRef(0);

  useEffect(() => {
    if (state.syncOpenRequest > handled.current) {
      handled.current = state.syncOpenRequest;
      setOpen(true);
      post({ t: "sync-open" });
    }
  }, [state.syncOpenRequest, post]);

  const panel = state.syncPanel;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent initialFocus={false} className="top-[10vh] flex max-h-[calc(100dvh-4rem)] translate-y-0 flex-col gap-3 overflow-hidden text-sm sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-base">Sync</DialogTitle>
        </DialogHeader>
        {!panel ? (
          <p className="text-xs text-muted-foreground">Checking…</p>
        ) : panel.state === "unpaired" ? (
          <SyncConnectForm panel={panel} />
        ) : (
          <PairedBody panel={panel} />
        )}
      </DialogContent>
    </Dialog>
  );
}

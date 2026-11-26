import { Button } from "@/components/ui/button";
import { CloudOffIcon } from "lucide-react";
import { useStore } from "../../store";

const LABEL = { offline: "Sync offline", revoked: "Sync: device removed" } as const;

/** Silent while sync is healthy or off; it only appears when there is something to fix. */
export function SyncStatusChip() {
  const { state, openSync } = useStore();
  if (state.syncStatus !== "offline" && state.syncStatus !== "revoked") { return null; }
  return (
    <Button variant="ghost" size="xs" onClick={openSync} className="text-attention">
      <CloudOffIcon aria-hidden />
      {LABEL[state.syncStatus]}
    </Button>
  );
}

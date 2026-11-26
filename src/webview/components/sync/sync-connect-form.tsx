import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useId, useState } from "react";
import type { SyncField, SyncPanel } from "../../../protocol/messages";
import { useStore } from "../../store";

type Unpaired = Extract<SyncPanel, { state: "unpaired" }>;

function Field({ label, value, onChange, error, helper, placeholder, autoFocus }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  helper?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const note = error ?? helper;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground/80">{label}</label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error !== undefined || undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {note && <p id={`${id}-note`} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>{note}</p>}
    </div>
  );
}

/** Not paired yet: joining with a code is the common case; setting up a fresh server is the quieter alternative. */
export function SyncConnectForm({ panel }: { panel: Unpaired }) {
  const { post } = useStore();
  const [mode, setMode] = useState<"join" | "setup">("join");
  const [server, setServer] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState(panel.defaultName);
  const errorFor = (field: SyncField) => (panel.error?.field === field ? panel.error.message : undefined);
  const join = mode === "join";

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (panel.busy) { return; }
        post({ t: join ? "sync-join" : "sync-setup", server: server.trim(), code: code.trim(), name: name.trim() });
      }}
    >
      <p className="text-xs text-muted-foreground">
        Sync memory and sessions between your machines through a server you run. It only ever stores encrypted data.
      </p>
      <Field label="Server address" value={server} onChange={setServer} placeholder="https://sync.example.com" error={errorFor("server")} autoFocus />
      <Field
        label={join ? "Pairing code" : "Setup code"}
        value={code}
        onChange={setCode}
        placeholder={join ? "MRC-…" : "MRB-…"}
        error={errorFor("code")}
        helper={join ? undefined : "The code your server printed when it started."}
      />
      <Field label="Device name" value={name} onChange={setName} error={errorFor("name")} />
      {panel.error && panel.error.field === undefined && <p role="alert" className="text-xs text-destructive">{panel.error.message}</p>}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="link" size="xs" className="px-0 text-muted-foreground" onClick={() => setMode(join ? "setup" : "join")}>
          {join ? "Set up a new server instead" : "Join with a pairing code instead"}
        </Button>
        <Button type="submit" size="sm" disabled={panel.busy}>{join ? "Join" : "Set up"}</Button>
      </div>
    </form>
  );
}

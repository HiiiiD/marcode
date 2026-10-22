import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsIndicator, TabsList, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useId, useState } from "react";
import { parseMcpSnippet } from "../../../client-core/mcp/parse-snippet";
import { splitCommandLine } from "../../../client-core/mcp/split-command";
import { validateSpec } from "../../../client-core/mcp/validate-spec";
import type { McpCapabilities, McpScope, McpServerSpec, McpTarget } from "../../../protocol/messages";
import { McpKeyValueRows, toRecord, toRows, type KeyValueRow } from "./mcp-key-value-rows";

type Kind = "stdio" | "http" | "sse" | "json";

const quoteArg = (a: string): string => (/\s/.test(a) ? `"${a}"` : a);

function Field({ id, label, children, hint }: { id: string; label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function McpAddForm({ capabilities, targets, takenIn, onSubmit, onBack }: {
  capabilities: McpCapabilities;
  targets: Record<McpScope, McpTarget> | null;
  takenIn: (scope: McpScope) => string[];
  onSubmit: (scope: McpScope, server: McpServerSpec) => void;
  onBack: () => void;
}) {
  const ids = useId();
  const [kind, setKind] = useState<Kind>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState<KeyValueRow[]>([]);
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<KeyValueRow[]>([]);
  const [json, setJson] = useState("");
  const firstAvailable: McpScope = targets && "unavailable" in targets.repo ? "global" : "repo";
  const [scope, setScope] = useState<McpScope>(firstAvailable);
  const [error, setError] = useState<string | undefined>();

  const target = targets?.[scope];

  const usePasted = () => {
    const parsed = parseMcpSnippet(json);
    if ("error" in parsed) { setError(parsed.error); return; }
    const s = parsed.server;
    setError(undefined);
    if (s.name) { setName(s.name); }
    if (s.transport === "stdio") {
      setKind("stdio");
      setCommand([s.command, ...s.args].map(quoteArg).join(" "));
      setEnv(toRows(s.env));
      setCwd(s.cwd ?? "");
    } else {
      setKind(s.transport === "sse" && capabilities.sse ? "sse" : "http");
      setUrl(s.url);
      setHeaders(toRows(s.headers));
    }
  };

  const submit = () => {
    let spec: McpServerSpec;
    if (kind === "stdio") {
      const split = splitCommandLine(command);
      if ("error" in split) { setError(split.error); return; }
      spec = { name: name.trim(), transport: "stdio", command: split.command, args: split.args, env: toRecord(env) };
      if (capabilities.workingDirectory && cwd.trim() !== "") { spec.cwd = cwd.trim(); }
    } else {
      spec = { name: name.trim(), transport: kind === "sse" ? "sse" : "http", url: url.trim(), headers: toRecord(headers) };
    }
    const invalid = validateSpec(spec, takenIn(scope));
    if (invalid) { setError(invalid); return; }
    setError(undefined);
    onSubmit(scope, spec);
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(e) => { e.preventDefault(); if (kind === "json") { usePasted(); } else { submit(); } }}
    >
      <Tabs value={kind} onValueChange={(v) => { setKind(v as Kind); setError(undefined); }} className="min-w-0">
        <TabsList aria-label="Server type">
          <TabsTab value="stdio">stdio</TabsTab>
          <TabsTab value="http">HTTP</TabsTab>
          {capabilities.sse && <TabsTab value="sse">SSE</TabsTab>}
          <TabsTab value="json">Paste JSON</TabsTab>
          <TabsIndicator />
        </TabsList>
      </Tabs>

      {kind === "json" ? (
        <Field id={`${ids}-json`} label="JSON" hint="A snippet from a README: one server, with or without its mcpServers wrapper.">
          <Textarea
            id={`${ids}-json`}
            className="min-h-24 font-mono text-xs"
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
        </Field>
      ) : (
        <>
          <Field id={`${ids}-name`} label="Name">
            <Input id={`${ids}-name`} className="h-7 font-mono text-xs" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          {kind === "stdio" ? (
            <>
              <Field
                id={`${ids}-command`}
                label="Command"
                hint={capabilities.workingDirectory ? undefined : "Claude can't set a working directory — use the tool's own flag, e.g. uv --directory."}
              >
                <Input
                  id={`${ids}-command`}
                  className="h-7 font-mono text-xs"
                  placeholder="npx -y some-mcp-server"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  autoComplete="off"
                />
              </Field>
              {capabilities.workingDirectory && (
                <Field id={`${ids}-cwd`} label="Working directory">
                  <Input id={`${ids}-cwd`} className="h-7 font-mono text-xs" placeholder="optional" value={cwd} onChange={(e) => setCwd(e.target.value)} />
                </Field>
              )}
              <McpKeyValueRows label="Environment" keyPlaceholder="NAME" rows={env} onChange={setEnv} />
            </>
          ) : (
            <>
              <Field id={`${ids}-url`} label="URL">
                <Input id={`${ids}-url`} className="h-7 font-mono text-xs" placeholder="https://…/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <McpKeyValueRows label="Headers" keyPlaceholder="Authorization" rows={headers} onChange={setHeaders} />
            </>
          )}
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="pb-1 text-xs text-muted-foreground">Save to</legend>
            <RadioGroup value={scope} onValueChange={(v) => setScope(v as McpScope)} className="flex gap-4">
              {(["repo", "global"] as const).map((s) => (
                <label key={s} className={cn("flex items-center gap-1.5", targets?.[s] && "unavailable" in targets[s] && "opacity-50")}>
                  <RadioGroupItem value={s} disabled={Boolean(targets?.[s] && "unavailable" in targets[s])} />
                  {s === "repo" ? "Repo" : "Global"}
                </label>
              ))}
            </RadioGroup>
            {target && "path" in target && (
              <p className="text-muted-foreground wrap-break-word">
                Writes <span className="font-mono">{target.path}</span> · restart needed
              </p>
            )}
            {target && "path" in target && target.note && <p className="text-muted-foreground wrap-break-word">{target.note}</p>}
            {targets && (["repo", "global"] as const).map((s) => {
              const t = targets[s];
              return "unavailable" in t ? <p key={s} className="text-muted-foreground wrap-break-word">{t.unavailable}</p> : null;
            })}
          </fieldset>
        </>
      )}

      {error && <p role="alert" className="text-destructive wrap-break-word">{error}</p>}

      <div className="flex justify-end gap-1 border-t border-border pt-2">
        <Button type="button" variant="ghost" size="xs" onClick={onBack}>Back</Button>
        {kind === "json"
          ? <Button type="submit" size="xs">Use this</Button>
          : <Button type="submit" size="xs">Add</Button>}
      </div>
    </form>
  );
}

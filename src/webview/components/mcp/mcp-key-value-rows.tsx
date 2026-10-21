import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlusIcon, XIcon } from "lucide-react";

export interface KeyValueRow { key: string; value: string }

export function toRecord(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((r) => r.key.trim() !== "").map((r) => [r.key.trim(), r.value]));
}

export function toRows(record: Record<string, string>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

/** Env vars or headers: one editable row per pair. */
export function McpKeyValueRows({ label, rows, onChange, keyPlaceholder }: {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
}) {
  const update = (i: number, patch: Partial<KeyValueRow>) => {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="pb-1 text-xs text-muted-foreground">{label}</legend>
      {rows.map((row, i) => (
        <div key={i} className="flex min-w-0 items-center gap-1">
          <Input
            aria-label={`${label} name ${i + 1}`}
            className="h-7 min-w-0 flex-1 font-mono text-xs"
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            aria-label={`${label} value ${i + 1}`}
            className="h-7 min-w-0 flex-1 font-mono text-xs"
            placeholder="value"
            value={row.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${label.toLowerCase()} ${row.key || i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="self-start text-muted-foreground"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <PlusIcon aria-hidden data-icon="inline-start" />
        Add {label.toLowerCase() === "headers" ? "header" : "variable"}
      </Button>
    </fieldset>
  );
}

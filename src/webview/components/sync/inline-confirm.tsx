import { Button } from "@/components/ui/button";

/** A question in place of the row or action it is about, so a destructive step never needs a second dialog. */
export function InlineConfirm({ text, action, busy, onConfirm, onCancel }: {
  text: string;
  action: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" aria-label={text} className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
      <p className="text-xs text-foreground">{text}</p>
      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="xs" disabled={busy} onClick={onConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{action}</Button>
      </div>
    </div>
  );
}

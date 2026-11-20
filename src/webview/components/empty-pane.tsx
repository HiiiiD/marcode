import { findModel } from "../../shared/model-catalog";
import { folderName } from "../../client-core/folder-name";
import type { PaneState } from "../reducer";
import { useStore } from "../store";

/** Overlay, so it never changes the transcript's layout; the pane's height is the container it measures. */
export function EmptyPane({ pane }: { pane: PaneState }) {
  const { state } = useStore();
  const provider = state.catalog.find((p) => p.id === pane.summary.providerId);
  const model = findModel(provider?.models ?? [], pane.summary.model);
  const who = [model?.displayName ?? pane.summary.model, provider?.displayName].filter(Boolean).join(" · ");

  return (
    <div
      data-testid="empty-pane"
      style={{ containerType: "size" }}
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted-foreground"
    >
      <p className="max-w-full truncate" title={pane.summary.cwd}>
        {who}
        {pane.summary.cwd && <span> · {folderName(pane.summary.cwd)}</span>}
      </p>
      <p className="hidden [@container(min-height:220px)]:block">
        Type / for commands, @ for files or sessions, or drop files here
      </p>
    </div>
  );
}

import { createContext, useContext, useState, type ReactNode } from "react";

interface PaneDragValue {
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
}

const PaneDragContext = createContext<PaneDragValue | undefined>(undefined);

/**
 * Which session is mid-drag, shared above the whole `LayoutNodeView` tree.
 * Not carried in `dataTransfer` alone: jsdom's `DataTransfer.getData` during
 * `dragover` (as opposed to the final `drop`) is unreliable across browsers
 * by spec (`getData` is only guaranteed non-empty on `drop`), so the per-edge
 * hover highlight — which must update on every `dragover`, not just at
 * `drop` — reads this context instead.
 */
export function PaneDragProvider({ children }: { children: ReactNode }) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  return <PaneDragContext.Provider value={{ draggingId, setDraggingId }}>{children}</PaneDragContext.Provider>;
}

export function usePaneDrag(): PaneDragValue {
  const value = useContext(PaneDragContext);
  if (!value) { throw new Error("usePaneDrag must be used inside PaneDragProvider"); }
  return value;
}

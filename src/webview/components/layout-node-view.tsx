import { Fragment, useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
// react-resizable-panels ships ESM-only; a type-only import from a CommonJS
// module needs an explicit resolution-mode attribute (TS 5.3+) or tsc's
// per-file CJS/ESM interop check rejects it outright (TS1541) — see the
// similar note in pane-group.tsx and the vendored resizable.tsx.
import type { Layout, LayoutChangedMeta } from "react-resizable-panels" with { "resolution-mode": "import" };
import type { LayoutNode } from "../../protocol/messages";
import { EmptySlot } from "./empty-slot";
import { leafSessionIds } from "./layout-tree";
import { PaneContent } from "./pane-content";
import { usePaneDrag } from "./pane-drag-context";
import type { LeafDisplayState } from "./pane-layout";

type Edge = "top" | "bottom" | "left" | "right";
const EDGES: Edge[] = ["top", "bottom", "left", "right"];

/**
 * VS Code's own editor-group convention: top/bottom stack panes into rows
 * (this codebase's `orientation: 'vertical'` — see `resizable.tsx`'s
 * `flex-col` on that value), left/right line them up side by side
 * (`orientation: 'horizontal'`, the `flex-row` default).
 */
function edgeOrientation(edge: Edge): "vertical" | "horizontal" {
  return edge === "left" || edge === "right" ? "horizontal" : "vertical";
}

/** Drop on the leading edge (left/top) puts the dragged pane on that side, matching the drop gesture — the far/right or bottom edge appends it after the target instead, per VS Code's own editor-group convention. */
function edgeInsertsBefore(edge: Edge): boolean {
  return edge === "left" || edge === "top";
}

interface LayoutNodeViewProps {
  node: LayoutNode;
  path: number[];
  narrow: boolean;
  leafState: (sessionId: string | null) => LeafDisplayState;
  names: Map<string, string>;
  activeId: string | null;
  onLayoutChanged: (path: number[], layout: Layout, meta: LayoutChangedMeta, children: LayoutNode[]) => void;
  onFocusCapture: (sessionId: string) => void;
  /** A session's grab handle was dropped on this (ready) leaf's edge — split it 50/50 in the edge's orientation, with the dragged pane on the dropped side. */
  onSplit: (
    path: number[], orientation: "vertical" | "horizontal", draggedSessionId: string, insertBefore: boolean,
  ) => void;
  /** A session's grab handle was dropped on the middle of this (ready) leaf — the two sessions trade slots. */
  onSwap: (path: number[], draggedSessionId: string) => void;
  /** A session's grab handle was dropped directly on this empty leaf — assign it there, no split. */
  onDropAssign: (path: number[], draggedSessionId: string) => void;
  /**
   * Set only on the call `pane-group.tsx` makes directly. Governs the
   * root's own aria-label ("Open agent sessions" vs. a nested split's
   * "Split group") and, for the rare bare (unsplit) root, whether this call
   * must synthesize the wrapping `ResizablePanelGroup`/`ResizablePanel`
   * itself — normally that wrapping is supplied by the *parent* split's own
   * children map, but a bare leaf root has no parent split to do it.
   */
  topLevel?: boolean;
}

type LeafNode = Extract<LayoutNode, { kind: "leaf" }>;

/** Extra props a `ready` leaf's own `ResizablePanel` needs — the pane's accessible region name, its active/focus styling. Non-leaf and non-ready children get none of this: a split has no single session to name, and an `empty`/`pending` leaf is not a focus target. */
function leafPanelExtras(node: LayoutNode, ctx: LayoutNodeViewProps) {
  if (node.kind !== "leaf") { return {}; }
  if (ctx.leafState(node.sessionId) !== "ready") { return {}; }
  const name = ctx.names.get(node.sessionId!)!;
  return {
    role: "region" as const,
    "aria-label": `Session: ${name}`,
    "data-active": ctx.activeId === node.sessionId,
    "data-session-id": node.sessionId!,
    onFocusCapture: () => ctx.onFocusCapture(node.sessionId!),
    // A ring, not a background: at 300px a filled active pane would compete
    // with the permission card, which must stay the loudest thing on
    // screen — it's the only transcript item demanding an action.
    className: cn("border border-transparent transition-colors", ctx.activeId === node.sessionId && "border-ring/70"),
  };
}

/**
 * The `Fragment` key for a split's `i`-th child — session ids for a `split`
 * child, so a subtree keeps its DOM/state identity by its actual contents
 * rather than by array position; falls back to the index only when the
 * subtree holds no sessions (nothing stateful there to protect).
 */
function splitChildKey(child: LayoutNode, i: number): string {
  if (child.kind === "leaf") { return child.sessionId ?? `empty-${i}`; }
  const ids = leafSessionIds(child);
  return ids.length > 0 ? `split-${ids.join(",")}` : `split-${i}`;
}

/** The name a resize handle's aria-label should use for one side — a session's own title when that side is a single ready pane, a generic fallback when it's a subtree (a split, or an empty/pending leaf) with no one name to give. */
function siblingLabel(node: LayoutNode, ctx: LayoutNodeViewProps): string {
  if (node.kind === "leaf" && ctx.leafState(node.sessionId) === "ready") {
    return ctx.names.get(node.sessionId!)!;
  }
  return "panes";
}

/**
 * A leaf's own content, plus (when something is being dragged) its drop
 * targets. Pulled out as its own component rather than a plain helper
 * function because it needs `usePaneDrag` and per-leaf hover state — a
 * lowercase helper called inline from the parent's render body cannot own
 * hooks under the rules-of-hooks lint, which keys off the calling function's
 * name.
 */
function LeafContent({ node, path, ctx }: { node: LeafNode; path: number[]; ctx: LayoutNodeViewProps }) {
  const { draggingId, setDraggingId } = usePaneDrag();
  const [hoverEdge, setHoverEdge] = useState<Edge | null>(null);
  const [emptyHover, setEmptyHover] = useState(false);
  const [centerHover, setCenterHover] = useState(false);
  const state = ctx.leafState(node.sessionId);
  // A leaf can't be dropped onto the very session being dragged off it —
  // there is nothing sensible to split or assign in that case.
  const isDropTarget = draggingId !== null && draggingId !== node.sessionId;

  if (state === "empty") {
    return (
      <div
        className="relative h-full"
        data-testid={isDropTarget ? "drop-zone-empty" : undefined}
        onDragOver={(e) => { if (!isDropTarget) { return; } e.preventDefault(); setEmptyHover(true); }}
        // `dragleave` bubbles: crossing onto `EmptySlot`'s own button content
        // (a child of this div) would otherwise fire it and clear the
        // highlight while the pointer is still over the drop target. Same
        // guard as composer.tsx's file-drop zone.
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setEmptyHover(false); }
        }}
        onDrop={(e) => {
          if (!isDropTarget || draggingId === null) { return; }
          e.preventDefault();
          setEmptyHover(false);
          setDraggingId(null);
          ctx.onDropAssign(path, draggingId);
        }}
      >
        <EmptySlot path={path} />
        {isDropTarget && (
          <div
            aria-hidden
            className={cn("pointer-events-none absolute inset-0", emptyHover && "bg-ring/30")}
          />
        )}
      </div>
    );
  }
  if (state === "pending") {
    // Transient — corrected by the next reconcile pass, never interactive.
    return <div className="h-full" />;
  }

  const handleDrop = (edge: Edge) => {
    if (draggingId === null) { return; }
    setHoverEdge(null);
    setDraggingId(null);
    ctx.onSplit(path, edgeOrientation(edge), draggingId, edgeInsertsBefore(edge));
  };

  return (
    <div className="relative h-full">
      <PaneContent sessionId={node.sessionId!} accessibleTitle={ctx.names.get(node.sessionId!)!} />
      {isDropTarget && (
        <div
          data-testid="drop-zone-center"
          className={cn(
            "absolute inset-1/4 z-10 flex items-center justify-center border border-dashed border-ring/50 text-xs",
            centerHover && "bg-ring/30",
          )}
          onDragOver={(e) => { e.preventDefault(); setCenterHover(true); }}
          onDragLeave={() => setCenterHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setCenterHover(false);
            setDraggingId(null);
            ctx.onSwap(path, draggingId!);
          }}
        >
          <span aria-hidden className="pointer-events-none rounded bg-background/80 px-1.5 py-0.5">Swap</span>
        </div>
      )}
      {isDropTarget && EDGES.map((edge) => (
        <div
          key={edge}
          data-testid={`drop-zone-${edge}`}
          className={cn(
            "absolute z-10 flex items-center justify-center border border-dashed border-ring/50 text-xs",
            edge === "top" && "inset-x-0 top-0 h-1/4",
            edge === "bottom" && "inset-x-0 bottom-0 h-1/4",
            edge === "left" && "inset-y-0 left-0 w-1/4",
            edge === "right" && "inset-y-0 right-0 w-1/4",
            hoverEdge === edge && "bg-ring/30",
          )}
          onDragOver={(e) => { e.preventDefault(); setHoverEdge(edge); }}
          onDragLeave={() => setHoverEdge((cur) => (cur === edge ? null : cur))}
          onDrop={(e) => { e.preventDefault(); handleDrop(edge); }}
        >
          <span aria-hidden className="pointer-events-none rounded bg-background/80 px-1 py-0.5">Split</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Recursive `LayoutNode` renderer — a `split` becomes a nested
 * `ResizablePanelGroup`, a `leaf` becomes the real pane, an `EmptySlot`, or
 * (a `pending` leaf) an inert placeholder. Every `ResizablePanel` wrapping a
 * leaf child is built by its *parent* — that's what carries the leaf's
 * accessible region name and active/focus styling (`leafPanelExtras`) — so
 * this component's own `leaf` branch only ever returns bare content.
 * `topLevel` is the one exception: a bare (unsplit) root has no parent
 * split to have done that wrapping, so this synthesizes it directly.
 */
export function LayoutNodeView(props: LayoutNodeViewProps) {
  const { node, path, topLevel, narrow, onLayoutChanged } = props;

  if (node.kind === "leaf") {
    const content = <LeafContent node={node} path={path} ctx={props} />;
    if (!topLevel) { return content; }
    return (
      <ResizablePanelGroup orientation="vertical" aria-label="Open agent sessions">
        <ResizablePanel
          id="root"
          defaultSize="100%"
          minSize="15%"
          collapsible
          {...leafPanelExtras(node, props)}
        >
          {content}
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  const orientation = narrow ? "vertical" : node.orientation;
  return (
    <ResizablePanelGroup
      orientation={orientation}
      aria-label={topLevel ? "Open agent sessions" : "Split group"}
      // `onLayoutChange` is deprecated and, for pointer-driven resizes, fires
      // on every pointermove; `onLayoutChanged` fires once per completed
      // change and reports whether it was user-driven — skip the
      // non-interactive call it also makes on mount, since that one only
      // echoes the layout already in state. See pane-group.tsx's
      // `handleLayoutChanged` for the rest of this wiring.
      onLayoutChanged={(layout, meta) => onLayoutChanged(path, layout, meta, node.children)}
    >
      {node.children.map((child, i) => (
        // Keyed by session id (for a leaf), not by index: `removeSlotAt`
        // (or a drag-to-split move) can drop an earlier sibling and
        // shift a later leaf's session into this same array slot. `Composer`
        // keeps `text`/`ghost`/`refs`/`caret` in local `useState` with no
        // reset effect keyed on the session id — an index key would let
        // React reuse that `Composer`/`Transcript` instance across the
        // session swap and leak the departed session's half-typed draft
        // into the new one's pane. A `split` child is not exempt from this:
        // it holds its own stateful leaves (each with its own `Composer`),
        // and an index-keyed `split-${i}` let a sibling removal upstream
        // shift a split subtree into a DOM node React reuses for a
        // *different* split subtree — the same draft-leak bug, one level up,
        // that keying leaves by session id was supposed to close. See
        // `splitChildKey` for the actual-membership key that replaces it.
        <Fragment key={splitChildKey(child, i)}>
          {i > 0 && (
            <ResizableHandle
              aria-label={`Resize between ${siblingLabel(node.children[i - 1], props)} and ${siblingLabel(child, props)}`}
              withHandle
            />
          )}
          <ResizablePanel
            id={`${path.join("-")}-${i}`}
            defaultSize={`${child.size}%`}
            minSize="15%"
            collapsible
            {...leafPanelExtras(child, props)}
          >
            <LayoutNodeView {...props} node={child} path={[...path, i]} topLevel={false} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

import { Fragment } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
// react-resizable-panels ships ESM-only; a type-only import from a CommonJS
// module needs an explicit resolution-mode attribute (TS 5.3+) or tsc's
// per-file CJS/ESM interop check rejects it outright (TS1541) — see the
// similar note in pane-group.tsx and the vendored resizable.tsx.
import type { Layout, LayoutChangedMeta } from "react-resizable-panels" with { "resolution-mode": "import" };
import type { LayoutNode, SessionSummary } from "../../protocol/messages";
import { EmptySlot } from "./empty-slot";
import { PaneContent } from "./pane-content";
import type { LeafDisplayState } from "./pane-layout";

interface LayoutNodeViewProps {
  node: LayoutNode;
  path: number[];
  narrow: boolean;
  leafState: (sessionId: string | null) => LeafDisplayState;
  names: Map<string, string>;
  activeId: string | null;
  assignableSessions: SessionSummary[];
  onAssign: (path: number[], sessionId: string) => void;
  onLayoutChanged: (path: number[], layout: Layout, meta: LayoutChangedMeta, children: LayoutNode[]) => void;
  onFocusCapture: (sessionId: string) => void;
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
    onFocusCapture: () => ctx.onFocusCapture(node.sessionId!),
    // A ring, not a background: at 300px a filled active pane would compete
    // with the permission card, which must stay the loudest thing on
    // screen — it's the only transcript item demanding an action.
    className: cn("transition-colors", ctx.activeId === node.sessionId && "ring-1 ring-ring/40 ring-inset"),
  };
}

/** The name a resize handle's aria-label should use for one side — a session's own title when that side is a single ready pane, a generic fallback when it's a subtree (a split, or an empty/pending leaf) with no one name to give. */
function siblingLabel(node: LayoutNode, ctx: LayoutNodeViewProps): string {
  if (node.kind === "leaf" && ctx.leafState(node.sessionId) === "ready") {
    return ctx.names.get(node.sessionId!)!;
  }
  return "panes";
}

function renderLeafContent(node: LeafNode, path: number[], ctx: LayoutNodeViewProps) {
  const state = ctx.leafState(node.sessionId);
  if (state === "empty") {
    return (
      <EmptySlot
        assignable={ctx.assignableSessions}
        onAssign={(id) => ctx.onAssign(path, id)}
      />
    );
  }
  if (state === "pending") {
    // Transient — corrected by the next reconcile pass, never interactive.
    return <div className="h-full" />;
  }
  return (
    <PaneContent sessionId={node.sessionId!} accessibleTitle={ctx.names.get(node.sessionId!)!} />
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
    const content = renderLeafContent(node, path, props);
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
        <Fragment key={i}>
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

 
"use client";

// Vendored from the reui registry (`npx shadcn@latest add @reui/tree`),
// adapted for this project: `IconPlaceholder` (reui's multi-icon-library
// starter abstraction) replaced with a plain lucide-react `ChevronDownIcon`,
// matching every other icon import in this codebase. `TreeDragLine` dropped
// — it renders via `tree.getDragLineStyle()`, which only exists when a
// drag-and-drop feature is enabled on the `useTree` instance, and this
// surface never enables one (YAGNI; add back if drag-to-move is ever
// wanted).
//
// Base UI-backed (`@base-ui/react/merge-props`, `@base-ui/react/use-render`),
// not Radix — matches this project's UI primitives.
//
// `TreeItem`/`TreeItemLabel` are rendered for FOLDER rows only in this
// codebase (see `fleet-diff.tsx`): a headless-tree `ItemInstance`'s own
// `getProps()` carries its own `tabIndex`/`onClick` off its own focus model,
// which would fight the fleet-diff surface's existing roving-tabindex system
// if used for file rows — those keep rendering through the surface's own
// `FileRow`, untouched.

import { createContext, useContext } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ItemInstance } from "@headless-tree/core";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type ToggleIconType = "chevron" | "plus-minus"

interface TreeContextValue<T = any> {
  indent: number
  currentItem?: ItemInstance<T>
  tree?: any
  toggleIconType?: ToggleIconType
}

const TreeContext = createContext<TreeContextValue>({
  indent: 20,
  currentItem: undefined,
  tree: undefined,
  toggleIconType: "chevron",
});

function useTreeContext<T = any>() {
  return useContext(TreeContext) as TreeContextValue<T>;
}

interface TreeProps extends React.HTMLAttributes<HTMLDivElement> {
  indent?: number
  tree?: any
  toggleIconType?: ToggleIconType
}

function Tree({
  indent = 20,
  tree,
  className,
  toggleIconType = "chevron",
  ...props
}: TreeProps) {
  const containerProps =
    tree && typeof tree.getContainerProps === "function"
      ? tree.getContainerProps()
      : {};
  const mergedProps = { ...props, ...containerProps };

  const { style: propStyle, ...otherProps } = mergedProps;

  const mergedStyle = {
    ...propStyle,
    "--tree-indent": `${indent}px`,
  } as React.CSSProperties;

  return (
    <TreeContext.Provider value={{ indent, tree, toggleIconType }}>
      <div
        data-slot="tree"
        style={mergedStyle}
        className={cn("flex flex-col", className)}
        {...otherProps}
      />
    </TreeContext.Provider>
  );
}

interface TreeItemProps<T = any> extends Omit<
  useRender.ComponentProps<"button">,
  "indent"
> {
  item: ItemInstance<T>
  indent?: number
}

function TreeItem<T = any>({
  item,
  className,
  render,
  children,
  ...props
}: TreeItemProps<T>) {
  const parentContext = useTreeContext<T>();
  const { indent } = parentContext;

  const itemProps = typeof item.getProps === "function" ? item.getProps() : {};
  const mergedProps = { ...props, children, ...itemProps };

  const { style: propStyle, ...otherProps } = mergedProps;

  const mergedStyle = {
    ...propStyle,
    "--tree-padding": `${item.getItemMeta().level * indent}px`,
  } as React.CSSProperties;

  const defaultProps = {
    "data-slot": "tree-item",
    style: mergedStyle,
    className: cn(
      "z-10 ps-(--tree-padding) outline-hidden select-none not-last:pb-0.5 focus:z-20 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    ),
    "data-focus":
      typeof item.isFocused === "function"
        ? item.isFocused() || false
        : undefined,
    "data-folder":
      typeof item.isFolder === "function"
        ? item.isFolder() || false
        : undefined,
    "data-selected":
      typeof item.isSelected === "function"
        ? item.isSelected() || false
        : undefined,
    "aria-expanded": item.isExpanded(),
  };

  return (
    <TreeContext.Provider value={{ ...parentContext, currentItem: item }}>
      {useRender({
        defaultTagName: "button",
        render,
        props: mergeProps<"button">(defaultProps, otherProps),
      })}
    </TreeContext.Provider>
  );
}

interface TreeItemLabelProps<
  T = any,
> extends React.HTMLAttributes<HTMLSpanElement> {
  item?: ItemInstance<T>
}

function TreeItemLabel<T = any>({
  item: propItem,
  children,
  className,
  ...props
}: TreeItemLabelProps<T>) {
  const { currentItem } = useTreeContext<T>();
  const item = propItem || currentItem;

  if (!item) {
    console.warn("TreeItemLabel: No item provided via props or context");
    return null;
  }

  return (
    <span
      data-slot="tree-item-label"
      className={cn(
        "in-focus-visible:ring-ring/50 bg-background hover:bg-accent in-data-[selected=true]:bg-accent in-data-[selected=true]:text-accent-foreground flex items-center gap-1 transition-colors not-in-data-[folder=true]:ps-7 in-focus-visible:ring-[3px] [&_svg]:pointer-events-none [&_svg]:shrink-0",
        "rounded-md",
        "py-1.5",
        "px-2",
        "text-sm",
        className
      )}
      {...props}
    >
      {item.isFolder() && (
        // A ghost-icon-button-shaped box around the chevron, not just a
        // same-size icon: the tree/group headers above this row toggle
        // through an actual `Button variant="ghost" size="icon-xs"`, which
        // carries its own 24×24 box, 4px-radius corners, and a persistent
        // `bg-muted` while expanded (`aria-expanded:bg-muted`, one of
        // `Button`'s own variant rules, not a hover-only effect) — measured
        // against `rgb(37, 37, 38)` in a real render. Reproduced here with
        // the identical utility classes rather than a nested `<Button>`,
        // which isn't possible: `TreeItem` (the whole row) is already a
        // `<button>`, and a `<button>` inside a `<button>` is invalid HTML.
        // `in-aria-[expanded=...]`, not `group-aria-expanded:` — the
        // `aria-expanded` attribute this reads lives on that ancestor
        // `<button>`, not on this span, and `in-*` matches an ancestor's
        // state without needing a `group` marker class on it.
        <span className="in-aria-[expanded=true]:bg-muted hover:bg-muted inline-flex size-6 shrink-0 items-center justify-center rounded-[min(var(--radius-md),10px)] transition-colors">
          {/* No `text-muted-foreground`: the tree/group chevrons render at
              plain foreground color (`rgb(204, 204, 204)`, not the dimmer
              `rgb(157, 157, 157)` this measured at before), because `Button`
              sets no color of its own at rest — only `Button`'s ghost
              variant's `hover:text-foreground` name suggests dimming, and it
              doesn't actually apply one either. */}
          <ChevronDownIcon
            aria-hidden
            className="size-3 in-aria-[expanded=false]:-rotate-90"
          />
        </span>
      )}
      {children ||
        (typeof item.getItemName === "function" ? item.getItemName() : null)}
    </span>
  );
}

export { Tree, TreeItem, TreeItemLabel };

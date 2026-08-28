"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        // isolate: the indicator sits at -z-10 so it never paints over a tab's
        // own label (see TabsIndicator). Without a stacking context of its
        // own here, that negative z-index would rank below THIS element's
        // background too, not just its siblings — invisible behind bg-muted
        // rather than merely behind the tabs.
        "isolate relative flex min-w-0 items-center gap-1 rounded-lg bg-muted p-0.5",
        className
      )}
      {...props}
    />
  )
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "relative z-10 flex h-6 flex-1 items-center justify-center gap-1 rounded-[min(var(--radius-md),9px)] px-2 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors select-none data-[selected]:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    />
  )
}

function TabsIndicator({ className, ...props }: TabsPrimitive.Indicator.Props) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        // -z-10, not z-0: this renders after the tab buttons in the DOM, and
        // at an equal z-index a later sibling paints on top — which put an
        // opaque pill over the selected tab's own label text. A negative
        // z-index keeps it behind regardless of DOM order.
        "absolute top-0.5 bottom-0.5 left-0 -z-10 rounded-[min(var(--radius-md),9px)] bg-background shadow-sm transition-[translate,width] duration-150 ease-out",
        "translate-x-(--active-tab-left) w-(--active-tab-width)",
        className
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("flex min-h-0 min-w-0 flex-col gap-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab }

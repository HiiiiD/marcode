"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group flex w-full items-center rounded-lg border border-input bg-transparent transition-colors",
        // The composer's own textarea + block-start/block-end addons stack
        // vertically; a lone inline addon (the header's pencil icon beside a
        // single-line input) stays in the row. Keyed off the addon's own
        // `data-align`, not a prop threaded through this component, so a
        // consumer never has to tell the group what its children already say.
        "has-[>[data-align=block-start]]:flex-col has-[>[data-align=block-end]]:flex-col",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        "has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20",
        "dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-auto min-w-0 flex-1 border-0 bg-transparent px-2.5 py-1 shadow-none outline-none focus-visible:ring-0 dark:bg-transparent",
        className
      )}
      {...props}
    />
  )
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="input-group-textarea"
      className={cn(
        "w-full resize-none bg-transparent px-2.5 py-2 text-sm outline-none",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        "field-sizing-content max-h-40 min-h-16",
        className
      )}
      {...props}
    />
  )
}

function InputGroupAddon({
  className,
  align = "block-end",
  ...props
}: React.ComponentProps<"div"> & {
  align?: "block-start" | "block-end" | "inline-start" | "inline-end"
}) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "flex items-center gap-1.5 px-1.5 py-1",
        (align === "block-end" || align === "inline-end") && "order-last",
        (align === "block-start" || align === "inline-start") && "order-first",
        (align === "block-start" || align === "block-end") && "w-full",
        className
      )}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupInput, InputGroupTextarea }

"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      className={cn(
        "flex w-full flex-col rounded-lg border border-input bg-transparent transition-colors",
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        "has-aria-invalid:border-destructive has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20",
        "dark:bg-input/30",
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
        align === "block-end" && "order-last",
        align === "block-start" && "order-first",
        className
      )}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupTextarea }

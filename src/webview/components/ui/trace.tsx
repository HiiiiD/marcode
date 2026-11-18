import * as React from "react"
import { ChevronRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"

function Trace({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="trace"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  )
}

function TraceLine({
  className,
  status,
  ...props
}: React.ComponentProps<"span"> & {
  status?: "running" | "error" | "pending"
}) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground transition-colors data-[status=error]:text-destructive data-[status=pending]:opacity-60",
        className
      )}
      {...props}
    />
  )
}

function TraceIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5",
        className
      )}
      {...props}
    />
  )
}

function TraceTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-title"
      className={cn("min-w-0 truncate", className)}
      {...props}
    />
  )
}

function TraceDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="trace-description"
      className={cn("shrink-0 text-muted-foreground tabular-nums", className)}
      {...props}
    />
  )
}

function TraceCollapsible({
  className,
  bare,
  ...props
}: React.ComponentProps<typeof Collapsible> & {
  /** No frame: the row is just a line in a log, and its detail opens as a soft inset panel (see `TraceCollapsibleContent`'s `inset`). */
  bare?: boolean
}) {
  return (
    <Collapsible
      data-slot="trace-collapsible"
      className={cn(
        "flex w-full min-w-0 flex-col text-xs",
        !bare && "rounded border border-border",
        className
      )}
      {...props}
    />
  )
}

function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        "group/trace-collapsible-trigger flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-2 text-left text-[0.8rem] outline-none [&_svg:not([class*='size-'])]:size-3.5 transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {children}
      <TraceIcon className="ml-auto text-muted-foreground [.ml-auto~&]:ml-0 transition-transform duration-200 group-aria-expanded/trace-collapsible-trigger:rotate-90">
        <ChevronRightIcon />
      </TraceIcon>
    </CollapsibleTrigger>
  )
}

function TraceCollapsibleContent({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof CollapsibleContent> & { inset?: boolean }) {
  return (
    <CollapsibleContent data-slot="trace-collapsible-content" {...props}>
      <div
        data-slot="trace-collapsible-content-inner"
        className={cn(
          "min-w-0 wrap-break-word",
          inset ? "mt-0.5 mb-2 ml-[7.375rem] py-1" : "border-t border-border px-2 py-1.5",
          className
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  )
}

export {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
}

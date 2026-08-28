"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"

import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"

const Combobox = ComboboxPrimitive.Root

function ComboboxValue({ className, ...props }: ComboboxPrimitive.Value.Props & { className?: string }) {
  // Unlike `Select.Value`, `Combobox.Value` renders no element of its own —
  // it is a text/children accessor — so the trigger's styling hook has to be
  // a real wrapper around it.
  return (
    <span data-slot="combobox-value" className={cn("flex flex-1 text-left", className)}>
      <ComboboxPrimitive.Value {...props} />
    </span>
  )
}

function ComboboxTrigger({
  className,
  size = "default",
  children,
  ...props
}: ComboboxPrimitive.Trigger.Props & {
  size?: "sm" | "default"
}) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=combobox-value]:line-clamp-1 *:data-[slot=combobox-value]:flex *:data-[slot=combobox-value]:items-center *:data-[slot=combobox-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitive.Icon
        render={<ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />}
      />
    </ComboboxPrimitive.Trigger>
  )
}

/**
 * Portal + Positioner + Popup + the search input, in one wrapper: every call
 * site wants the same "type to filter" popup, and there is no case here
 * (unlike `SelectContent`'s side/align knobs) that needs to vary it.
 */
function ComboboxContent({
  className,
  children,
  placeholder = "Search…",
  empty = "No matches.",
}: {
  className?: string
  /** Forwarded straight to `Combobox.List` — a function child renders each
   * filtered item, which is what makes typing in the input actually narrow
   * the list; static children would render every item regardless of query. */
  children?: ComboboxPrimitive.List.Props["children"]
  placeholder?: string
  empty?: React.ReactNode
}) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        side="bottom"
        sideOffset={4}
        align="start"
        className="isolate z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "flex max-h-(--available-height) w-(--anchor-width) min-w-48 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
        >
          <ComboboxPrimitive.InputGroup className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <ComboboxPrimitive.Input
              placeholder={placeholder}
              className="w-full min-w-0 border-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </ComboboxPrimitive.InputGroup>
          <ComboboxPrimitive.Empty className="px-3 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0">
            {empty}
          </ComboboxPrimitive.Empty>
          <ComboboxPrimitive.List className="scroll-my-1 overflow-y-auto p-1">
            {children}
          </ComboboxPrimitive.List>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <span className="flex flex-1 shrink-0 items-center gap-2 whitespace-nowrap">
        {children}
      </span>
      <ComboboxPrimitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <CheckIcon className="pointer-events-none" />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  )
}

export { Combobox, ComboboxContent, ComboboxItem, ComboboxTrigger, ComboboxValue }

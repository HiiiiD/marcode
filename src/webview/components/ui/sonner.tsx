import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * No `next-themes` here (this isn't Next.js): the panel's light/dark split is
 * `body.vscode-dark` / `body.vscode-light` (see index.css), driven by VS
 * Code, not by React state — there is nothing to read a `theme` from. The
 * `--normal-*` vars below are the same `--popover`/`--border` tokens every
 * other vendored primitive uses, and those already resolve per VS Code
 * theme at `:root`, so Sonner's own light/dark palette is overridden
 * regardless of which one it thinks it's in.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }

# Local edits to installed termcn files

Reapply after `shadcn add ... --overwrite`.

| File | Edit | Why |
|---|---|---|
| `lib/terminal-themes/default.ts` | `import type { Theme } from "@termcn/components/ui/types"` | the CLI leaves the registry's `@/components/ui/types` alias unrewritten in this item |
| `components/ui/dialog.tsx` | `interactive?: boolean` (default true): when false, no key handling and no OK/Cancel row | Enter would cancel; we only want the frame |
| `components/ui/dialog.tsx` | `inverse={...}` on `<text>` becomes `attributes={... ? TextAttributes.INVERSE : 0}` (import from `@opentui/core`) | `inverse` is not a `TextProps` key in `@opentui/react` 0.5.13, so the registry code fails `check-types:tui` |
| `components/ui/tool-call.tsx` | spinner interval only while `status === "running"` | stock code ticks 12 times a second on every instance forever |
| `components/ui/confirm.tsx` | `flexDirection="row"` on the button row (`<box gap={2} paddingLeft={2}>`) | OpenTUI boxes default to a column; the registry code assumes a row, so Yes/No stacked over blank rows |
| `components/ui/tool-call.tsx` | `flexDirection="row"` on the header `<box gap={1}>` | same: status icon, name and duration stacked |
| `components/ui/chat-message.tsx` | `flexDirection="row"` on the header `<box gap={1}>` | same: sender name and time stacked |

Registry items written for Ink-style row defaults need this check after install: render one and look for stacked rows.

## Install notes

- `package.json` lists `@opentui/react` so the CLI skips its own dependency install (it would otherwise run `yarn add` in this folder and fail; the package is a marker, not a yarn workspace).
- Install: `yes n | npx shadcn@latest add @termcn/opentui/<name> --yes --cwd src/tui/ui/termcn`. The `yes n` answers "no" to the overwrite prompts for already-installed shared files (`types`, `default`, `use-theme`), which `--yes` does not skip and which would otherwise undo the patch above.

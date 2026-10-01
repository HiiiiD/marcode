# Local edits to installed termcn files

Reapply after `shadcn add ... --overwrite`.

| File | Edit | Why |
|---|---|---|
| `lib/terminal-themes/default.ts` | `import type { Theme } from "@termcn/components/ui/types"` | the CLI leaves the registry's `@/components/ui/types` alias unrewritten in this item |
| `components/ui/dialog.tsx` | `interactive?: boolean` (default true): when false, no key handling and no OK/Cancel row | Enter would cancel; we only want the frame |

## Install notes

- `package.json` lists `@opentui/react` so the CLI skips its own dependency install (it would otherwise run `yarn add` in this folder and fail; the package is a marker, not a yarn workspace).
- Install: `yes n | npx shadcn@latest add @termcn/opentui/<name> --yes --cwd src/tui/ui/termcn`. The `yes n` answers "no" to the overwrite prompts for already-installed shared files (`types`, `default`, `use-theme`), which `--yes` does not skip and which would otherwise undo the patch above.

# HiiiiD Code

## Scope

A VS Code extension whose secondary-sidebar panel runs several coding-agent sessions at
once, in resizable split panes, with tool approvals handled in the UI and transcripts that
survive a window reload.

In scope:

- A roster of concurrent agent sessions, each its own conversation with its own status,
  model, effort level and permission mode.
- Split panes over the visible subset of that roster, with a persisted layout.
- Tool-permission requests surfaced as cards in the transcript, answered from the UI.
- Durable transcripts: per-session JSONL under `context.storageUri`, paged on demand.
- Two agent backends behind one interface — a scripted `FakeProvider` for tests and
  development, and the Claude Agent SDK for real work.

Out of scope: editing files directly, a terminal, anything that duplicates VS Code's own
chat UI.

Spec: [docs/superpowers/specs/2026-08-13-vscode-agent-manager-design.md](docs/superpowers/specs/2026-08-13-vscode-agent-manager-design.md)
Plan: [docs/superpowers/plans/2026-08-13-vscode-agent-manager.md](docs/superpowers/plans/2026-08-13-vscode-agent-manager.md)

## Architecture

**The extension host owns all state. The webview is a rendering client over `postMessage`.**
That single rule explains most of the code: `retainContextWhenHidden` stays off, the webview
holds nothing durable, and a reload is recovered by replaying host state through `hydrate`.

```
extension.ts
  └─ SessionManager ──── roster, visible set, patch fan-out
       ├─ AgentSession ── one conversation: coalesces deltas, parks approvals
       │    └─ AgentProvider ── FakeProvider | ClaudeProvider
       └─ TranscriptStore ── index.json + per-session JSONL

  MessageRouter ── WebviewToHost → SessionManager calls
  PanelViewProvider ── WebviewViewProvider: HTML, nonce, transport

           ▲  postMessage (typed, src/protocol/messages.ts)
           ▼

  webview/vscode-api.ts ── typed post/subscribe
  webview/reducer.ts ──── React-free reduce(ClientState, HostToWebview)
  webview/store.tsx ───── StoreProvider + useStore()
  webview/components/ ── panes, transcript, composer, permission card, roster
```

| Path | Responsibility |
|---|---|
| `src/extension.ts` | `activate()`: construct manager + store, register the webview view |
| `src/protocol/messages.ts` | Shared wire types. **Types only.** The one module both bundles import. |
| `src/providers/types.ts` | `AgentProvider`, `AgentRun`, `AgentEvent`, `ModelInfo` |
| `src/providers/fake/fake-provider.ts` | Scripted provider for tests and the walking skeleton |
| `src/providers/claude/` | Claude Agent SDK adapter and `SDKMessage` → `AgentEvent` mapping |
| `src/host/transcript-store.ts` | `index.json` + per-session JSONL; append, load, page |
| `src/host/agent-session.ts` | One conversation: transcript, status, pending approvals |
| `src/host/session-manager.ts` | Roster; create/close/delete; patch fan-out to the visible set |
| `src/host/message-router.ts` | `WebviewToHost` → manager calls. No `vscode` import, so it unit-tests. |
| `src/host/panel-view-provider.ts` | `WebviewViewProvider`; HTML + nonce; transport |
| `src/webview/` | Transport, reducer, store, components |

**Build:** esbuild produces two bundles — node/CJS for the host, browser/IIFE for the
webview. TypeScript, React 19, Tailwind v4.

**Tests:** mocha for unit tests (`yarn test:unit`, TDD-style `suite`/`test` globals),
`@vscode/test-cli` for integration (`yarn test`).

### Invariants

These are not style preferences. Breaking one breaks the design.

- **`src/protocol/messages.ts` is types-only.** No runtime code, no `vscode` import.
- **Nothing under `src/providers/` or `src/protocol/` imports `vscode`.** Neither does
  `src/host/message-router.ts`. This is what keeps them unit-testable outside the
  extension host.
- **Every protocol message addressed to a session carries an explicit `SessionId`.** There
  is no implicit "current session" on the wire.
- **Errors are state, never exceptions.** A failing provider puts a session into `error`
  with a transcript item. Nothing rejects across `postMessage`, and no handler leaves an
  unhandled rejection.
- **Transcript patches fan out only to visible sessions.** `sessions-changed` and
  `session-status` are ungated.
- **The webview loads no remote resources.** No CDN scripts, styles, fonts or images.
- **CSP:** `default-src 'none'`; scripts and styles restricted to `webview.cspSource` plus
  a per-load CSPRNG nonce; `localResourceRoots` pinned to `dist/`.
- **Filenames are kebab-case**, including React components (`session-list.tsx`, not
  `SessionList.tsx`). Component *identifiers* stay PascalCase.

## UI: shadcn is mandatory

**Use shadcn components. Never raw HTML controls in feature code.**

No bare `<select>`, `<button>`, `<input>`, or `<textarea>`. Use `Select`, `Button`,
`Input`, `Textarea`, `DropdownMenu` and friends from `@/components/ui/*`. If a control you
need is not vendored yet, vendor it — do not hand-roll it and do not reach for a raw
element "just this once".

- The registry is **Base UI**-backed (`@base-ui/react`), **not Radix**. Import parts from
  the vendored file. Do not mix in Radix packages.
- Primitives are vendored into `src/webview/components/ui/`. Tailwind picks them up through
  the esbuild plugin — no config change needed when you add one.
- **Use the short Tailwind utilities**: `border-border`, `bg-muted`, `text-muted-foreground`.
  The `@theme inline` block in `src/webview/index.css` registers every token under the
  `--color-*` namespace, so `[var(--…)]` arbitrary values are never needed and must not
  appear in component code.

## Conventions

- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after
  every task.
- Extension host target: VS Code `^1.125.0`, Node 22.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before a commit.

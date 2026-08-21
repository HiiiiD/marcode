# Marcode

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
  PostBus ──────── fan-out; each registered client supplies its own `wants` predicate

           ┌─────────────────┴─────────────────┐
           ▼ PanelViewProvider                  ▼ ReviewPanel
   WebviewView, all messages           WebviewPanel, its own MessageRouter (answers
                                        what it asked for) + REVIEW_WANTS on the bus
                                        (the manager's unsolicited fan-out only)
           │  postMessage                       │  postMessage
           ▼  (typed, src/protocol/messages.ts) ▼

  webview/vscode-api.ts, reducer.ts,   review/store.tsx, reducer.ts (reduceReview),
  store.tsx, components/ ── panes,     fleet-diff.tsx ── the review surface, its own
  transcript, composer, roster, diff   narrow ReviewState (no byId, no layout, no composer)
```

| Path | Responsibility |
|---|---|
| `src/extension.ts` | `activate()`: construct manager + store + `PostBus` + `ReviewPanel`, register the sidebar webview view, the `marcode.review.open` command, and the review tab's `WebviewPanelSerializer` |
| `src/protocol/messages.ts` | Shared wire types. **Types only.** The one module every bundle imports. |
| `src/providers/types.ts` | `AgentProvider`, `AgentRun`, `AgentEvent`, `ModelInfo` |
| `src/providers/fake/fake-provider.ts` | Scripted provider for tests and the walking skeleton |
| `src/providers/claude/` | Claude Agent SDK adapter and `SDKMessage` → `AgentEvent` mapping |
| `src/providers/claude/map-context.ts` | SDK context response → `ContextBreakdown`; structured usage response → `UsageWindow[]` |
| `src/providers/acp/acp-client.ts` | Child stdio → an ACP `ClientSideConnection`; loaded via async `import()` since the SDK is ESM-only and the host bundle is CJS |
| `src/providers/acp/map-updates.ts` | `session/update` → `AgentEvent`; the `ToolMapper` seam is where a vendor plugs in its own tool shapes |
| `src/providers/acp/config-options.ts` | `session/new`'s `configOptions` → `ModelInfo[]` and mode ids |
| `src/providers/acp/permissions.ts` | Permission-option selection off the request's real `optionId`/`kind`, plus `bypass`/`dontAsk` auto-answer policy |
| `src/providers/acp/acp-run.ts` | `AcpRun implements AgentRun` — one ACP session: prompt, cancel, model/mode switches, permission relay |
| `src/providers/opencode/opencode-provider.ts` | `OpenCodeProvider implements AgentProvider`: spawns `opencode acp`, probes models, `threadScope: 'cwd'` |
| `src/providers/opencode/map-tools.ts` | OpenCode's ACP tool calls → this project's canonical `ToolCall` — the `ToolMapper` for this vendor |
| `src/shared/usage-windows.ts` | Fixed display order for usage windows; shared so neither provider nor host owns the other's table |
| `src/shared/file-cap.ts` | `FILE_CAP`/`MAX_FILE_CAP` — shared so the host and the review webview agree on the default and ceiling without importing across the host/webview boundary |
| `src/host/transcript-store.ts` | `index.json` + per-session JSONL; append, load, page |
| `src/host/agent-session.ts` | One conversation: transcript, status, pending approvals |
| `src/host/session-manager.ts` | Roster; create/close/delete; patch fan-out to the visible set |
| `src/host/self-control-mcp-server.ts` | One loopback HTTP MCP server exposing `marcode__spawn_session` to every session's provider; started at `activate()`, token/url threaded into all three provider constructors |
| `src/host/message-router.ts` | `WebviewToHost` → manager calls. No `vscode` import, so it unit-tests. |
| `src/host/panel-view-provider.ts` | `WebviewViewProvider`; HTML + nonce; transport |
| `src/host/webview-html.ts` | One CSP and nonce for every webview surface |
| `src/host/post-bus.ts` | Fan-out to registered clients; `REVIEW_WANTS` is the review tab's allow-list |
| `src/host/review-panel.ts` | The review editor tab: creation, restore, transport |
| `src/host/fleet-diff.ts` | One tree's change set: base resolution, numstat + untracked parsing |
| `src/host/claim-paths.ts` | Provider edit paths → git's repo-relative POSIX spelling |
| `src/host/diff-content-provider.ts` | `mar-diff:` scheme — a file's content at the base ref, via `git show` |
| `src/webview/` | Transport, reducer, store, components |
| `src/webview/components/context-ring.tsx` | Context-fill ring + breakdown popover, mounted in the composer |
| `src/webview/components/usage-strip.tsx` | Panel-level account usage windows |
| `src/webview/components/tool-render.ts` | `(name, input, output)` → one-line header + typed blocks. Pure; no React. |
| `src/webview/components/tool-body.tsx` | Renders those blocks — command, diff, path, todos, clamped output |
| `src/review/` | The review client: its own reducer, store and surface |
| `src/review/fleet-diff.tsx` | The fleet diff surface: trees, session groups, file rows |
| `src/review/fleet-diff-groups.ts` | Pure grouping of a flat `TreeDiff` into session groups |

**Build:** esbuild produces three bundles — `dist/extension.js` (node/CJS, the host) and two
browser/IIFE webview bundles, one per surface: `dist/webview.js`/`.css` for the sidebar and
`dist/review.js`/`.css` for the review tab. TypeScript, React 19, Tailwind v4.

**Tests:** mocha for unit tests (`yarn test:unit`, TDD-style `suite`/`test` globals, run
straight from source through the `tsx/cjs` hook), mocha + jsdom for webview DOM tests
(`yarn test:dom`, components mounted under a real `StoreProvider` and driven with genuine
`HostToWebview` messages — see `src/test/dom/harness.tsx`), `@vscode/test-cli` for
integration (`yarn test`).

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
- **DOM tests drive components through the real `StoreProvider`.** State arrives as genuine
  `HostToWebview` messages via `sendFromHost`; assertions read the messages the webview
  posted back. Never mock `useStore` or hand-build a `ClientState` — a fake provider bypasses
  `reduce` and lets a test pass against a state the host could never produce.
- **Never pass a DOM node to an assertion.** Compare a boolean, a string, or a count —
  `assert.strictEqual(container.querySelector('div') === null, true)`, never
  `assert.strictEqual(container.querySelector('div'), null)`. A failing `assert` builds its
  message with `util.inspect` on the actual value, and a jsdom element reaches its parents,
  its `ownerDocument` and that document's `window`, so inspecting one div walks the entire
  graph. This is not a slow leak: the node-valued form allocated **3.5GB in 4 seconds** and
  took a developer machine down on 2026-08-14. It only detonates while the test is red,
  which is exactly when you are running it. `screen.getByX` helpers are safe — they throw
  their own message and never hand the node to `assert`.
- **Which providers exist is a setting; whether they work is a probe.**
  `marcode.enabledProviders` (default `["claude","codex"]`) decides what
  `activate()` registers, and a provider left out is not constructed at all — it
  appears in neither `catalog()` nor `unavailable()`, because "nobody asked for this
  backend" is not a diagnosis of it. `fake` is a legal value, never a default: a
  shipped panel offering it would offer a backend that answers "ok" to everything.
  Emptying the setting is how the no-provider empty state is reached on purpose.
  Registration happens once, at activate, so a change prompts a window reload rather
  than pretending to apply live.
- **An empty catalog is two different claims, and `probing` is which one.** Nobody
  has answered yet, or nothing here can run an agent — one second apart, and only
  the second is a diagnosis. `hydrate` answers it from `SessionManager.willProbe()`,
  `refreshModels` closes it with `probing: false` *even when it asked nobody*, and
  the webview reads an absent field as "still probing". The empty state waits while
  probing, lists per-provider reasons once settled, and — with nothing enabled, so
  nothing to re-ask — offers the setting instead of a retry.
- **A provider's model list is its availability.** Models come from the backend,
  so an empty list means the backend never answered — there is no hardcoded fallback
  catalog, because listing a model is also a claim that this install can run it.
  `SessionManager.catalog()` carries only providers with models, `create()` refuses the
  rest, and `unavailable()` carries them with the reason their last probe gave.
  Re-probing (`refreshModels`) is the whole mechanism for re-checking an install.
  The one permitted stand-in is `SessionManager.seededModels`, restored from
  `catalog.json`: the list a provider's **last successful probe** returned, consulted only
  while its own `listModels()` is still empty. It exists because hydrate ships whatever
  `catalog()` says at `ready`, and without it every restored pane spends the first second
  read-only with a dead model switcher. It is a stand-in for an answer, never a substitute
  for one — `refreshModels` deletes it the moment the probe replies, success or failure, so
  it cannot survive one real answer. A **failure** is still never persisted: a restored
  reason would describe an install nobody checked this launch.
- **Usage and context surfaces read in percentages.** Every *share* — the ring, the
  slices, the usage windows, each memory file — is a percentage, and a token count may
  never stand in for one. The single exception is the context dialog's window line
  (`usedTokens` / `windowTokens` on `ContextBreakdown`): a percentage cannot say which
  window it is a percentage of, and 17% of 258k and 17% of 1M are the same reading of very
  different sessions. It is quoted once, as the bar's caption, and providers report both
  fields or neither. Everywhere else tokens stay inside the mappers
  (`src/providers/claude/map-context.ts`, `src/providers/codex/map-usage.ts`).
- **Plan usage is pulled, never read off `rate_limit_event`.** That event carries no
  utilization at steady state — only `status` is required — so a strip built on it renders
  nothing. It is a signal that a pull is due. Numbers come from `AgentProvider.fetchUsage`
  (no session needed, used at activation) or `AgentRun.usageWindows` (the live query). Its
  `resetsAt` is epoch **seconds** and its `utilization`, when present, is a **0–1 fraction**;
  the structured response uses ISO strings and **0–100**. Do not mix the two scales.
- **Diff content comes from git; diff attribution comes from the transcript.**
  Git sees one dirty tree when three sessions share a root, so a file's owner is
  whichever sessions' canonical `file-edit` tool calls claimed its path — never
  inferred from git. A change with no tool call behind it (a shell command, a
  build, the user) is **unattributed**, and says so. Claims are never persisted:
  they describe a tree at an instant, and a restored claim would describe an
  install nobody checked this launch, the same reason a failed model probe never
  reaches `catalog.json`. `SessionManager` rebuilds the pre-launch half from the
  JSONL on demand. Attribution is recorded **above** the subagent early return in
  `agent-session.ts`, unlike relocation: a subagent's edit changed *this*
  session's tree and is this session's change on disk.
- **The review tab is a second client, not a second source of truth.** It
  registers on the `PostBus` with `REVIEW_WANTS`, but that allow-list governs
  only `SessionManager`'s fan-out (`sessions-changed`, `session-status`,
  `fleet-diff`) — a new message type posted through the manager defaults to
  not reaching review, and `session-patch` never will, because the review
  client simply never asks for it. It is not the whole story, though:
  `ReviewPanel` also owns its own `MessageRouter`, whose `emit` posts straight
  to the same webview outside the bus entirely — that is how `hydrate` and
  `editor-context` actually reach this client, each in direct answer to a
  message it sent (`ready`). The allow-list is what stops an *unsolicited*
  broadcast from reaching review; a request this client makes gets its answer
  regardless of the allow-list. (`'hydrate'` is correspondingly absent from
  `REVIEW_WANTS`: nothing ever `bus.post`s one, only the router's `emit`
  does, so listing it there would claim a fan-out path that does not exist.)
  Visible-set gating stays in `SessionManager` and is not re-decided anywhere
  else. Its view state (collapse, opened rows) is deliberately ephemeral: both
  describe a reading position in a list that re-reads itself while agents
  work, so a restored one would describe a tree nobody checked this launch.
- **ACP is the protocol layer, not a provider.** `src/providers/acp/` may not
  import anything vendor-specific; a new ACP agent is a spawn recipe plus a
  `map-tools.ts`. Client capabilities stay `false` for fs and terminal — an
  agent that calls them anyway falls back to its own IO, which is what keeps
  diff attribution reading the transcript instead of our writes.

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
- **Compose classNames with `cn` from `@/lib/utils`** — never template literals or string
  concatenation. Conditional segments are arguments (`cn('h-7', active && 'border-destructive')`),
  not interpolations. `cn` is `twMerge(clsx(...))`, so it resolves conflicting Tailwind
  utilities; a template literal leaves both in the class list and lets source order decide,
  which silently breaks any conditional override of a base color or size.
- **Prefer the short Tailwind utilities for plain token lookups**: `border-border`,
  `bg-muted`, `text-muted-foreground`. The `@theme inline` block in
  `src/webview/index.css` registers every token under the `--color-*` namespace, so
  `bg-[var(--color-muted)]` is just a worse spelling of `bg-muted` — don't write that.
- **Arbitrary values are fine when you need a computation the utility scale can't
  express.** shadcn's own vendored source does this, and matching it is correct:
  `rounded-[min(var(--radius-md),10px)]`, `bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]`.
  The test is whether a plain utility would say the same thing — if it would, use it; if
  the value is derived (`min()`, `calc()`, `color-mix()`), reach for the arbitrary value.

## UI changes go through impeccable

**Every change to the webview UI is checked with the `impeccable` skill before it is
called done.** Not just new surfaces — a moved button, a changed label, a new state, a
restyled card. The skill is the quality gate for this panel, the same way `yarn lint` is
the gate for the code.

- **Before building** a new surface or reshaping an existing one, invoke the skill and let
  it route: `shape` to plan the UX, or its new-work flow for a replacement visual world.
- **After changing** any file under `src/webview/components/`, run the mechanical detector
  over what you touched:
  `node <impeccable-skill-dir>/scripts/detect.mjs --json <changed files>`
  Exit 0 is clean, exit 2 means findings. A non-zero exit is a failing check, not a
  suggestion.
- **Periodically, and before merging a UI branch**, run `critique` over `src/webview` and
  compare against the previous run already sitting in the working tree's
  `.impeccable/critique/` (that directory is gitignored — a fresh clone has no baseline
  until `critique` has run there at least once). The score is expected to go up, never
  down.
- Remember the mode: this panel is **Operate**, not Persuade. The visitor is completing a
  task in a 300–500px sidebar during a long-running agent turn. Scanability, consistency,
  native VS Code expectations and that real usage scene outrank expression. Brand lives in
  precise details, not in decoration.

The detector only catches mechanical tells. It passing is necessary, not sufficient — a
clean scan over an under-designed surface is exactly what the 2026-08-13 critique found.

## Conventions

- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `docs:`. Commit after
  every task.
- Extension host target: VS Code `^1.125.0`, Node 22.
- `yarn lint`, `yarn check-types` and `yarn run compile` must all pass before a commit.

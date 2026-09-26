# Always allow on permission cards

> **Status: dropped 2026-09-26.** Not shipped: session-scoped rules widen what an agent can do unprompted (edits + test runner = code execution; broad read rules). If revisited, prefer provider-native mechanisms (Claude suggestions pinned to the session destination, Codex acceptForSession, ACP allow_always). Only the compact diff preview and the fixed button row landed.

## Goal

A permission card offers "Always allow" next to Allow and Deny. Marcode itself remembers the
rule for the rest of that session's run and auto-answers matching requests, on every provider.
The same change adds a compact inline diff preview for edit approvals and keeps Approve/Deny in
a fixed position on every card.

## Decisions

- **Marcode-native, not provider-native.** The Claude SDK's `PermissionUpdate` suggestions are
  not mirrored, Codex `acceptForSession` and ACP `allow_always` are not used. One host-side rule
  engine behaves identically across Claude, Codex, OpenCode and the fake provider. Providers are
  untouched; `ToolDecision` is unchanged.
- **Scope: this session, in memory.** Rules are never persisted and are cleared on dispose or
  reload (same reasoning as diff claims: a restored rule would describe nothing checked this
  launch). Marcode never writes a settings file.
- **Match: tool kind plus a narrow key.** Never a blanket "allow Bash".

## Rule engine — `src/host/permission-rules.ts`

Pure, no `vscode` import.

- `ruleFor(tool: ToolCall): { key: string; label: string } | undefined`
  - edit/write tools: key is the tool kind (any file).
  - shell: key is first word + subcommand (`git status`). A command containing `&&`, `||`, `;`,
    `|`, `` ` ``, `$(`, or a redirect yields `undefined`.
  - MCP: `server` + tool name.
  - plan and question tools: `undefined`, never eligible.
- `matches(key: string, tool: ToolCall): boolean` — recomputes `ruleFor(tool)?.key`.
- Shell rules ignore trailing arguments: "always allow `git status`" covers any `git status …`.

## Wire (`src/protocol/messages.ts`, types only)

- `PermissionRequest` and the `permission` transcript item gain `alwaysRule?: { label: string }`,
  e.g. "Always allow `git status`". The rule key never crosses the wire.
- `permission-decision` gains `always?: true`. It still carries `SessionId` and `requestId`.

## Host flow — `AgentSession`

- On a `permission` event, if any stored key matches, call `respondToTool(id, { allow: true })`
  at once. The transcript item is recorded as allowed with reason
  "auto-allowed by rule: <label>"; the session never enters `awaiting-approval`.
- Otherwise park as today, attaching `alwaysRule` when `ruleFor` returns one.
- On a decision with `always: true` for a request that has a rule: store the key, then allow.
  `always` on a deny or on an ineligible request is ignored.
- Subagent requests are matched too: rules belong to the session.
- `MessageRouter` forwards `always` to the manager; no `vscode` import added.

## Card UI — `permission-card.tsx` (shadcn `Button` only)

- Button row: **Deny · Allow · Always allow**. Deny and Allow keep their current positions on
  every card; Always allow is an outline/ghost `Button` after them, `title` = rule label, hidden
  when `alwaysRule` is absent. Plan cards unchanged.
- Edit tools show a compact diff (about 6 lines, expandable) above the buttons via the existing
  `ToolBody` diff block. Buttons sit below in a fixed row, so preview height never moves them.
- All buttons disable together via the existing `answered` state.
- Classes composed with `cn`; short Tailwind token utilities.

## Testing

- Unit: `ruleFor`/`matches` (incl. chained-command rejection, MCP, edit); `AgentSession`
  auto-answer, rule stored on `always`, cleared on dispose, no `awaiting-approval` on match,
  `always` ignored on deny; `MessageRouter` passthrough.
- DOM (real `StoreProvider`, `sendFromHost`): button shown/hidden by `alwaysRule`; click posts
  `always: true`; Deny/Allow DOM order stable with and without the extra button; diff preview
  renders for edits. Never pass DOM nodes to assertions.
- Gates: `yarn lint`, `yarn check-types`, `yarn run compile`, `yarn test:unit`, `yarn test:dom`,
  impeccable skill + `detect.mjs` over changed `src/webview/components/` files.

## Out of scope

Persisted or user/project-scoped rules, a rule list/revoke UI, Claude `suggestions` mirroring,
provider-native always-allow.

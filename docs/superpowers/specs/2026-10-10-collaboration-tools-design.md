# Collaboration tools: `spawn_collaborators` and `get_context_usage`

Two additions to the self-control MCP server (`src/host/self-control-mcp-server.ts`).

## Motivation

- The user repeatedly tells an agent to spawn sessions that collaborate on one working tree. A tool
  removes the repeated instruction and makes the protocol uniform.
- An agent cannot see how full its context is. The host already measures it for the context ring,
  but only at turn end, so a long turn can exhaust the window before anyone looks.

## 1. `marcode__spawn_collaborators`

### Shape

One lead (the caller) spawns N workers in one call. All share one working tree.

```
workers: [{ task, scope?, commit?, provider?, model?, effort? }]
cwd?: string            // default: caller's cwd; must be absolute
brief?: string          // shared context/rules copied to every worker
```

Returns `{ workers: [{ sessionId, task }] }`.

`spawn_session` stays as the raw primitive; this tool is built on the same create/send/reveal path.
Provider, model, effort and mode inherit from the caller exactly as `spawn_session` does. `bypass`
is refused or dropped by the same rules.

### Team scoping

The team is the lead plus the workers created by this call, and nothing else. Each worker's
preamble names only the lead and its siblings (ids and tasks). Sessions outside the team are never
mentioned, and `list_sessions` output is not injected.

Team membership is not persisted in v1. It exists only in the preambles. (A `teamId` on
`SessionState` is a possible later step; see Non-goals.)

### Worker preamble (prepended to `task`)

- You share this working tree with the lead (`<id>`) and these siblings: `<id: task>, ...`.
- Your task and, if given, your scope. Do not edit outside scope. Do not revert changes you did not make.
- Commits (when `commit` is not `false`, the default):
  - Commit only files you edited: `git add <your paths>`, then `git commit -m "..." -- <your paths>`.
  - Never `git add -A`, `git add .` or `git commit -a`.
  - Never `stash`, `reset`, `clean`, `rebase`, force-push, or `checkout`/`restore` on paths you do not own.
  - Never `--amend` a commit you did not make.
  - On `index.lock`, wait a few seconds and retry; never delete the lock.
  - Do not push. Only the lead pushes.
  - Follow the repo's commit conventions.
- When `commit` is `false`: leave changes uncommitted for the lead to review.
- Coordinate shared resources (devices, ports, builds) directly with teammates via `marcode__send_message`,
  agreeing a protocol among themselves; message the lead only for results, blockers or decisions.
- The team `brief`, if given.
- When done, `marcode__send_message` the lead a short result plus the commit hashes made, or
  "no commits".

### Lead-side guidance

The tool result text tells the lead: before pushing, run `git status` and `git log` to confirm every
worker finished and nothing is left staged or dirty.

### Errors

Same validation as `spawn_session` per worker. Validate all workers before creating any, so a bad
entry does not leave a partial team. A failure while creating worker K closes the workers already
created (still empty, so discarded) and reports the error.

### Non-goals (v1)

- No enforcement. Scope and git rules are prompt-level; nothing stops a worker running
  `git add -A`. Real enforcement needs per-worker worktrees (conflicts with the shared-tree intent)
  or a shell guard.
- No `send_message` restriction to team members, and no persisted `teamId`. Manual cross-session
  messages from the user must keep working. Revisit if prompt scoping proves leaky.
- No auto-close of workers when the lead finishes.

## 2. `marcode__get_context_usage`

### Shape

No required arguments. The caller is identified as in the other tools. Optional `name` (as in the other tools) lets a
lead check a worker.

Returns `{ percent, usedTokens, windowTokens, stale? }`.

- `percent` is the headline, `Math.round(100 - freePercent)`, the same number the ring shows.
- `usedTokens` / `windowTokens` are the context dialog's single permitted token exception (see
  AGENTS.md); providers report both or neither. If absent they are omitted.
- `stale: true` when the live query failed or timed out while the session is mid-turn, so the value is the
  cached `lastContext` from the end of the previous turn. An idle session's cache is current and is not marked.

### Behavior

New `AgentSession.measureContext()`:

1. Call `run.contextBreakdown?.()` live, with a ~3s timeout.
2. On success, write through `applyContextPercent` (so the ring updates mid-turn too) and return it.
3. On timeout or error, return `lastContext` with `stale: true`.
4. If the provider has no `contextBreakdown`, or the session has not started, return an error text.
   Never a fabricated number.

Provider behavior:

| Provider | Source | Mid-turn freshness |
|---|---|---|
| Claude | `queryRef.getContextUsage()` (SDK control request) | Unverified, see risk |
| Codex | last `thread/tokenUsage/updated` | As of last model call |
| OpenCode (ACP) | last `usage_update` | As of last model call |

The tool description must say that the value can lag by up to one model call (ACP/Codex) and may be
stale when `stale` is set.

### Open risk

It is **not verified** that Claude's `getContextUsage()` answers while a tool call is running. If the
SDK queues control requests behind the running tool, the live query is useless in exactly the case
motivating this feature (a long turn). The timeout fallback keeps the tool from hanging but returns
the turn-start value.

First implementation step: call `getContextUsage()` during a long Bash tool call on a Claude session
and measure latency. If it blocks, fall back to deriving a running figure from per-assistant-message
`usage` in the stream, if the SDK emits it, and update this spec with the outcome.

Implementation note: `SessionManager.contextBreakdown(id)` already provided the live query, timeout and
cached fallback; the tool exposes it, and `ContextResult` gained the optional `stale` flag.

**Probe status: PENDING.** Needs a live Claude session on the new build: in A run Bash `sleep 90`; in B call
`marcode__get_context_usage` with A's `name` while it runs. Fresh in about 1-3s with no `stale` means the risk
is cleared; `stale: true` after the ~5s manager timeout, or an answer only after the sleep ends, means the SDK
queues control requests behind the running tool. Record the outcome here.

## Testing

- Unit, `self-control-mcp-server.test.ts`: collaborators preamble contains only team members and
  never a bystander session; `commit: false` omits the commit rules; validate-all-before-create;
  bypass handling matches `spawn_session`; default cwd.
- Unit, `agent-session`: `measureContext()` fresh path, timeout fallback sets `stale`, no-provider
  support returns an error, `applyContextPercent` is invoked on the fresh path.
- Tool tests use `FakeProvider` with `reports.context`; they do not mock the manager.

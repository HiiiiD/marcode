# hiiiid-code — Invocable Catalog (Skills and Slash Commands)

**Date:** 2026-08-13
**Status:** Design approved; amended after the SDK spike and again after the
2026-08-13 UX overhaul landed (lazy query start, `impeccable shape`). Pending
implementation plan.
**Builds on:** [2026-08-13-vscode-agent-manager-design.md](2026-08-13-vscode-agent-manager-design.md),
[2026-08-13-subagents-and-mcp-design.md](2026-08-13-subagents-and-mcp-design.md)

## Overview

A session's skills and slash commands are invisible in the panel. The user
cannot see what the agent can do, and cannot invoke a skill without already
knowing its exact name — so skills that exist go unused, and typed names fail
silently as ordinary prose.

This surfaces the catalog of everything invocable in a session's working
directory as one `/` autocomplete menu in the composer, opened either by typing
`/` or from a permanent control on the composer's addon row.

It is a read-path feature over provider-reported state. It adds no
configuration, no discovery rules, and no persistence.

## Goals

- See every skill and slash command available in the session's repo.
- Invoke one without knowing its exact name.
- **Work before the first message.** Creating a session in order to run a slash
  command is the primary case, not an edge one.
- Attribute each entry to its origin, so same-named entries are distinguishable.
- Stay correct without the extension knowing how skills resolve.

## Non-goals

- **Configuration.** Which skills exist and where they come from stay in the
  CLI's own config and directories. No settings UI, no enable/disable.
- **Forcing a skill.** Selecting an entry writes text into the composer. The
  model still decides what to do with it.
- **Skill contents.** No body rendering, no preview pane. Name, description,
  origin, arg hint — nothing that requires reading a skill file.
- **A chrome strip or count pill.** Cut during `impeccable shape`; see UI.
- **Fuzzy matching.** Substring only; see Filtering.

## Sequencing

Independent of the subagent/MCP spec — they touch adjacent code but share no
data. Either can land first. Nothing here depends on the MCP strip existing,
since the strip this spec once proposed is gone.

## Provider seam

One new `AgentEvent` variant and one new type.

```ts
export type AgentEvent =
  | /* …existing variants… */
  | { kind: 'invocables'; entries: Invocable[] };

export type Invocable = {
  /** Verbatim from the provider: 'brainstorming', 'superpowers:brainstorming', 'init'. */
  name: string;
  /** One line. Rendered as the menu subtitle. */
  description?: string;
  /**
   * Plugin or namespace prefix, when the name carries one. Badge, and
   * collision disambiguation. Absent for unqualified names.
   */
  origin?: string;
  /** e.g. '[interval] [prompt]'. Rendered as ghost text after insertion. */
  argHint?: string;
};
```

**There is no `kind`.** The SDK spike (see Risks) established that skills and
slash commands arrive as one undifferentiated list with no discriminator. A
`kind` field would have to be guessed at, and a guessed badge that says `skill`
about `/init` is worse than no badge.

**`origin` is derived from the name, not reported.** A name of the form
`prefix:leaf` yields `origin: 'prefix'`; the `name` is still stored verbatim,
because that is what gets inserted into the composer. Unqualified names get no
origin — personal, project, and built-in are not distinguishable, and the spec
declines to invent a distinction the provider cannot support.

**A snapshot, not a delta.** The full array each time: at session init, and on
any change the provider notices. Entries number in the tens, so diffing is
complexity for nothing, and replace-whole makes hydrate and live update the same
code path. This is deliberately the same shape as `mcp-servers`.

**One emit at init is a complete implementation of the contract.** Change
detection — file watchers, plugin installs — is the provider's business and may
not exist. Nothing above the seam assumes a second emit will arrive.

For the Claude provider it does exist: the SDK pushes a `commands_changed`
system message carrying the full replacement list, which maps straight to a
second `invocables` emit with no extra machinery.

**Empty and unknown are different states.** An empty array means "this cwd has
none". Never having answered means "we have not been told". The user sees the
same thing either way (see States), but the distinction is preserved in the host
field (`Invocable[] | undefined`) because the retry rule depends on it: a failed
probe caches nothing and is retried, an empty answer is an answer.

**Names cross the seam verbatim.** The host never parses `plugin:skill`, never
resolves collisions, never validates that a typed `/name` exists. That is the
provider's job, and delegating it is what guarantees the panel cannot drift from
CLI behaviour when skill resolution changes.

`FakeProvider` gains a scripted emit, so every test in this spec runs with no
SDK, no VS Code, and no network.

### The probe: `AgentProvider.listInvocables`

The push event alone is not enough, because the Claude provider constructs its
SDK query **lazily, on the first `send()`** — a deliberate design (only query
construction can set `bypass`, so the permission mode must stay editable until
the first message). `supportedCommands()` is a method on `Query`. No query, no
catalog.

That collides with the primary use: creating a session specifically to run a
slash command as its first message. A menu that appears only after the first
send is dead at exactly the moment it is wanted.

So the seam gains a second, optional entry point:

```ts
export interface AgentProvider {
  // …existing members…
  /**
   * The catalog for a working directory, with no session required. Optional:
   * a provider that cannot answer simply omits it.
   */
  listInvocables?(cwd: string): Promise<Invocable[]>;
}
```

The Claude implementation constructs a throwaway query over a prompt stream
that never yields, calls `supportedCommands()`, and closes it. Nothing is ever
sent, so there is no turn, no tokens, and no agent work — only the CLI's init
handshake. It runs at most once per `providerId + cwd` per window (see
Lifecycle), so the cost is one short-lived subprocess per repository.

The push event stays: it is what keeps a long-running session current when
skills are discovered mid-run. Probe answers "what is available here", the
event answers "what changed since".

### Rejected alternatives

**Pull-only, on `AgentRun`.** The menu re-filters on every keystroke, so a
per-open round-trip would need host caching anyway — the push design with
latency bolted on. Worse, it inherits the lazy-start problem: a run's query may
not exist yet.

**Warming the session's own query at creation.** Would make the catalog
available without a separate probe, but it undoes lazy start, which exists so
`bypass` can still be chosen before the first message.

**Host-side filesystem scan.** Would work without provider support, at the cost
of duplicating the CLI's discovery and precedence rules in a second
implementation that silently diverges the moment they change.

## Lifecycle

**The catalog belongs to a working directory, not to a session.** Skills resolve
from the filesystem and the user's config; two sessions on the same repo see the
same list. Keying it per session would run the same probe once per pane and
still produce identical answers.

A host-side `CatalogService` owns it, keyed by `providerId + cwd`:

- **Probe once per key.** Fired when a session for that key is created or
  re-opened. Concurrent callers await the same in-flight promise; a completed
  probe is served from memory for the life of the extension host.
- **Fan out to every session on that key**, present and future. A session
  created after the probe resolved gets the cached list immediately.
- **A live `invocables` event refreshes the entry it belongs to**, and re-fans
  to every session sharing it. A running session that discovers new skills
  therefore updates the menu of an idle sibling on the same repo.
- **Failure caches nothing.** The next session creation retries. No error UI: a
  catalog that will not load leaves the composer as plain text.

In-memory only. Nothing reaches `TranscriptStore`, `StoredIndex`, or
`SessionState`, and a window reload re-probes.

This makes the menu available **before the first message**, which is the point:
the common case is creating a session in order to run a slash command.

An archived session still resolves against its `cwd`, so its menu works too —
and it should, because sending to an archived session re-opens it. What the
catalog describes is the repo, and the repo has not gone anywhere.

On hydrate the host replays the current entry per pane, so a webview reload is
indistinguishable from a fresh probe.

## Persistence

None. No new store code, no migration, no version field. The record of what a
skill actually did lives in the transcript's tool cards, which already exist.

## UI

The menu is the entire surface. **There is no chrome strip and no count pill.**

An earlier draft put a `24 commands` pill in the pane header beside the MCP one.
The 2026-08-13 critique found that header already losing its space contest — the
model label holds `ml-auto` while session status makes do with an 8px dot — and
a third element would have made that worse to show a number nobody acts on.
Awareness and invocation are the same gesture here, so one surface serves both:
opening the menu with an empty query *is* the list of what this session can do.

### `/` menu

**Two ways in, one menu.** Typing `/` as the first character of an empty
composer opens it filtered; a quiet `/ commands` control on the composer's
addon row opens it unfiltered. The control is the discovery affordance — it
teaches by being permanently present, with no first-run tip to dismiss and no
dismissal state to persist (which the architecture would put on the host, not
the webview).

**Trigger discipline:** position 0 only, so `src/foo` and a pasted URL never
open it. It closes at the first whitespace, because that is where arguments
begin and where the composer needs Enter back.

**Rows are two lines**, because at 300px a name, a description and an origin
badge cannot share one:

```
brainstorming
Turn ideas into designs
writing-plans              superpowers
Plan before touching code
```

Line one is the name, with the origin badge right-aligned when the name is
qualified. Line two is the description, clamped to one line, muted. Roughly
seven rows fit at the default sidebar width — names are the scan target, and
descriptions are present without a hover the panel has no room to rely on.

**Order is the provider's, flat.** No origin grouping: the badge already says
where an entry came from, and group headings would spend a third of a short
list's vertical budget on chrome.

**The menu opens above the textarea.** Downward would run off the bottom of the
pane, which is where the composer already sits.

**Keys, claimed only while open and released on close:** arrows move, Enter or
Tab selects, Escape closes and leaves the typed text untouched. Any other key
falls through to the composer and re-filters.

**Selection inserts `/name ` with a trailing space, cursor at the end.** The
`argHint` renders as ghost text after the cursor and clears on the first
keypress or on send. Ghost text is presentation-only: it never enters the
message body, and the send path asserts this.

**Cap: 50 rendered rows, then a `+N more` line.** Same reasoning as
`SUBAGENT_CHILD_WINDOW` — bounded DOM, no windowing library, one named constant
(`INVOCABLE_MENU_WINDOW`) to tune after watching real use. Typing narrows below
the cap immediately, so the cap only ever governs the unfiltered first view.

**A query matching nothing renders one muted `No match` row**, not an empty
box and not a vanished menu. A menu that disappears mid-keystroke silently
hands Enter back to the composer, so the next Enter sends `/xyz` as a message
instead of doing nothing — the user's model of what the key does must not
change without them seeing why.

**Accessibility.** The list is `role="listbox"` with `aria-activedescendant`
tracking the highlighted row, so the entry under the cursor is announced. The
highlight is a background fill *and* the panel's standard focus treatment,
never colour alone.

### States

| State | Menu | Affordance |
|---|---|---|
| Catalog not yet probed | `/` inert, plain text | absent |
| Probe failed | `/` inert, plain text | absent |
| Empty catalog | `/` inert, plain text | absent |
| Catalog present | opens | visible |
| Query matches nothing | one `No match` row | visible |

The three unavailable states are deliberately indistinguishable to the user:
each means "this composer is plain text right now", and none of them is
actionable from the panel.

### Filtering

Substring, case-insensitive, over `name` then `description`.

Ranking: name matches above description matches; within name matches, earlier
match position first, then alphabetical. Predictable, trivial to test, no scorer
to tune.

Fuzzy subsequence matching was considered — `brnst` finding `brainstorming` is
genuinely nicer for long plugin-prefixed names — and rejected for this version:
it needs a scoring function and its own test surface, and substring already
reaches every entry because matching runs over the whole name including the
plugin prefix.

**Aliases are ignored.** The SDK reports alternate names for some commands
(`/cost` and `/stats` both resolving to `/usage`). Indexing them would double
the menu's apparent size for entries that do the same thing. Deferred to Future.

**Long names truncate in the middle**, keeping the prefix and the leaf
(`document-skills:…:pptx` style), with the full name on the row's title
attribute.

## Testing

All against `FakeProvider` and injected fakes. No SDK, no VS Code, no network.

Unit (`yarn test:unit`):

- **Probe caching** — one probe per `providerId + cwd`; a second session on the
  same cwd triggers no second probe and receives the cached list; a different
  cwd probes again; a failed probe caches nothing and the next session retries.
- **Fan-out** — a probe resolving after two sessions exist reaches both; a live
  `invocables` event refreshes the entry and re-fans to siblings.
- **Snapshot replace** — successive events replace wholesale; hydrate replays
  the current entry.
- **Empty vs unknown** — an empty array is a cached answer; a failure is not.
- **Filtering** — `brain` ranks `brainstorming` above an entry that merely
  mentions brainstorming in its description; equal-position ties break
  alphabetically; a query matching nothing yields no rows.
- **Trigger discipline** — `menuQuery` opens at position 0 only and closes at
  the first whitespace.
- **Insertion** — `/name ` exactly, trailing space present; the arg hint is
  returned separately from the inserted text.
- **Cap** — 200 entries render 50 rows plus `+150 more`; filtering to 3 renders
  3 rows and no more-line.
- **Origin derivation** — `superpowers:brainstorming` yields origin
  `superpowers` and keeps its full name; `init` yields no origin; a name with
  two colons keeps everything after the first as the leaf.
- **Claude mapping** — a `SlashCommand` with `argumentHint: ''` maps to an
  `Invocable` with no `argHint`; a `commands_changed` message maps to an
  `invocables` event carrying the full list.

DOM (`yarn test:dom`, real `StoreProvider`, state delivered as genuine
`HostToWebview` messages per CLAUDE.md):

- Typing `/` opens the menu; `src/foo` does not; a space closes it.
- Arrow keys move `aria-activedescendant`; Enter selects; Escape closes and
  leaves the typed text alone; with the menu closed, Enter still posts `send`.
- Selecting an entry puts `/name ` in the textarea and the arg hint outside it;
  the posted `send` text contains no hint.
- A no-match query renders exactly one `No match` row.
- A pane with no catalog renders no affordance and `/` does nothing.

## Risks

**SDK exposure — resolved by spike, 2026-08-13.** Read from the installed
`@anthropic-ai/claude-agent-sdk` type definitions:

- `Query.supportedCommands(): Promise<SlashCommand[]>` — one merged list of
  skills and slash commands, available on a live session.
- `SlashCommand = { name; description; argumentHint; aliases? }`. No kind, no
  origin, no source path.
- `SDKCommandsChangedMessage` (`system` / `commands_changed`) pushes the full
  replacement list mid-session.
- `SDKControlInitializeResponse.commands` carries the same list at init.

The feature ships. The cost of the merged list is the `kind` field and the
Skills/Commands split, both dropped above.

**`supportedCommands()` needs a query, and the session's query is lazy.**
Resolved by the probe (see Provider seam): a throwaway query per `cwd`, never
sent to, closed as soon as it answers. Its failure is swallowed — nothing is
cached, the composer stays plain text, and the next session on that cwd retries.
A catalog that fails to load must never take a session down with it.

**The probe spawns a CLI subprocess.** One per repository per window, at session
creation, living only as long as the control response takes. If that proves
slow enough to notice, the fallback is not to remove it but to start it earlier
— nothing about the design depends on *when* the probe runs, only that it runs
without a session.

**`argumentHint` is provider-authored and may be empty.** An empty string maps
to `argHint: undefined`, so ghost text is absent rather than blank.

**Menu key handling collides with the composer.** The composer owns Enter and
likely arrow-key history. A handler that leaks after close makes Enter stop
sending — strictly worse than having no menu. The menu claims those keys only
while open, releases them on every close path (Escape, selection, emptied
query, blur), and the trigger-discipline test covers it.

**Descriptions are provider-authored and unbounded.** Skill descriptions in the
wild run to paragraphs. Rows clamp to one line with ellipsis; the full text is
not shown anywhere in this version.

**The composer's addon row already wraps at 300px.** Effort, permission mode and
Send do not fit on one line, which is why that row is `flex-wrap`. The `/
commands` control has to be small enough not to force a third line — icon-scale,
not a labelled button competing with the two selects.

## Future

- **Aliases**, either as extra matchable strings on an entry or as a hint on the
  row, once there is evidence anyone misses them.
- **Fuzzy matching**, if long prefixed names prove annoying in practice.
- **Description on hover or in an expanded row**, once there is evidence a
  one-line clamp is losing something users need.

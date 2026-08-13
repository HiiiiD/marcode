# hiiiid-code — Invocable Catalog (Skills and Slash Commands)

**Date:** 2026-08-13
**Status:** Design approved, pending implementation plan
**Builds on:** [2026-08-13-vscode-agent-manager-design.md](2026-08-13-vscode-agent-manager-design.md),
[2026-08-13-subagents-and-mcp-design.md](2026-08-13-subagents-and-mcp-design.md)

## Overview

A session's skills and slash commands are invisible in the panel. The user
cannot see what the agent can do, and cannot invoke a skill without already
knowing its exact name — so skills that exist go unused, and typed names fail
silently as ordinary prose.

This surfaces the catalog of everything invocable in the live session: a `/`
autocomplete menu in the composer, and a chrome strip listing what is available.

It is a read-path feature over provider-reported state. It adds no
configuration, no discovery rules, and no persistence.

## Goals

- See every skill and slash command available in the live session.
- Invoke one without knowing its exact name.
- Attribute each entry to its origin, so same-named entries are distinguishable.
- Stay correct without the extension knowing how skills resolve.

## Non-goals

- **Configuration.** Which skills exist and where they come from stay in the
  CLI's own config and directories. No settings UI, no enable/disable.
- **Forcing a skill.** Selecting an entry writes text into the composer. The
  model still decides what to do with it.
- **Skill contents.** No body rendering, no preview pane. Name, description,
  origin, arg hint — nothing that requires reading a skill file.
- **Catalog in archived sessions.** See Lifecycle.
- **Fuzzy matching.** Substring only; see Filtering.

## Sequencing

Independent of the subagent/MCP spec — they touch adjacent code but share no
data. Either can land first. This spec assumes the MCP strip's visual language
exists; if it does not yet, this strip defines it and the MCP one conforms.

## Provider seam

One new `AgentEvent` variant and one new type.

```ts
export type AgentEvent =
  | /* …existing variants… */
  | { kind: 'invocables'; entries: Invocable[] };

export type Invocable = {
  /** Verbatim from the provider: 'brainstorming', 'superpowers:brainstorming', 'init'. */
  name: string;
  kind: 'skill' | 'command';
  /** One line. Rendered as the menu subtitle. */
  description?: string;
  /** 'personal' | 'project' | plugin name. Badge, and collision disambiguation. */
  origin?: string;
  /** e.g. '[interval] [prompt]'. Rendered as ghost text after insertion. */
  argHint?: string;
};
```

**A snapshot, not a delta.** The full array each time: at session init, and on
any change the provider notices. Entries number in the tens, so diffing is
complexity for nothing, and replace-whole makes hydrate and live update the same
code path. This is deliberately the same shape as `mcp-servers`.

**One emit at init is a complete implementation of the contract.** Change
detection — file watchers, plugin installs — is the provider's business and may
not exist. Nothing above the seam assumes a second emit will arrive.

**Empty and unknown are different states.** An empty array means "this session
has none". Never having emitted means "we have not been told". Both hide the
strip, but the distinction is preserved in the host field (`Invocable[] |
undefined`) because a future affordance — a retry, an explanatory line — needs
it, and collapsing them now would be unrecoverable.

**Names cross the seam verbatim.** The host never parses `plugin:skill`, never
resolves collisions, never validates that a typed `/name` exists. That is the
provider's job, and delegating it is what guarantees the panel cannot drift from
CLI behaviour when skill resolution changes.

`FakeProvider` gains a scripted emit, so every test in this spec runs with no
SDK, no VS Code, and no network.

### Rejected alternatives

**Pull method (`AgentRun.listInvocables(): Promise<Invocable[]>`).** Fresher on
paper. But the protocol is currently one-way push plus a few commands, and the
menu re-filters on every keystroke — so the result must be cached host-side
anyway, which is the push design with a round-trip bolted on.

**Provider-level `listInvocables(cwd)`, no run required.** Would let archived
sessions show a catalog. It contradicts the live-only lifecycle below, and needs
SDK surface that likely does not exist outside a session.

**Host-side filesystem scan.** Would work without provider support, at the cost
of duplicating the CLI's discovery and precedence rules in a second
implementation that silently diverges the moment they change.

## Lifecycle

Live-run state only. `AgentSession` holds the last snapshot in a field, exactly
as it holds the MCP snapshot: in memory, not written to the transcript, not part
of `SessionState`, gone when the run ends.

A run exists from `AgentSession` construction, before the first user message
(`provider.start` in the constructor), so a freshly created session has its
catalog immediately — the composer menu works on the first keystroke of a brand
new session.

An archived or unloaded session shows **no strip at all**, and its `/` menu never
opens. A stale catalog offering entries that no longer resolve would be worse
than none: it invites an invocation that fails. Typing a name by hand still
works — the composer falls through to plain text, and the provider parses it.

On hydrate of a live session the host replays the current snapshot, so a webview
reload is indistinguishable from a fresh init.

## Persistence

None. No new store code, no migration, no version field. The record of what a
skill actually did lives in the transcript's tool cards, which already exist.

## UI

### Chrome strip

A pill beside the MCP one: `24 skills`. Click expands a grouped list.

**The count is skills only.** Commands (`/init`, `/review`, …) would inflate it
with entries the user did not install and rarely browses. The pill is a
discovery hint, not a metric; commands still appear in the expanded list and in
the menu.

Expanded: `Skills`, then `Commands`. Within each, grouped by origin — personal,
project, then plugins alphabetically. Each row is `name — description`, with the
origin implied by its group heading.

Absent entirely when the snapshot is empty or unknown. No empty state.

### `/` menu

**Trigger:** `/` typed as the first character of an empty composer. Not
mid-text — so `src/foo` and a URL never open it. Closing and reopening requires
clearing back to empty, which is deliberate: a menu that reappears mid-sentence
is a menu that steals Enter.

**Rows** are the same component as the strip's rows: `name — description
[origin]`. One component, two mounts.

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

**Long names truncate in the middle**, keeping the prefix and the leaf
(`document-skills:…:pptx` style), with the full name on the row's title
attribute.

## Testing

All against `FakeProvider`. No SDK, no VS Code, no network.

- **Snapshot replace** — successive `invocables` events replace wholesale;
  hydrate replays the current one; an archived session receives none.
- **Empty vs unknown** — an empty array hides the strip; never-emitted hides the
  strip; the host field distinguishes them; the composer stays usable in both.
- **Filtering** — `brain` ranks `brainstorming` above an entry that merely
  mentions brainstorming in its description; equal-position ties break
  alphabetically; a query matching nothing renders an empty menu, not a crash.
- **Trigger discipline** — `/` at position 0 opens the menu; `/` after any
  character does not; Escape closes without mutating composer text; after close,
  Enter sends as normal.
- **Insertion** — `/name ` exactly, trailing space present, cursor at end; ghost
  text is absent from the sent message body.
- **Cap** — 200 entries render 50 rows plus `+150 more`; filtering to 3 renders
  3 rows and no more-line.

## Risks

**SDK exposure is unverified and the whole feature is downstream of it.** Step 1
of the implementation plan is a spike against the installed package, not
implementation. Two facts to check:

1. Skills available to a live session are enumerable, with descriptions.
2. Slash commands are too.

Degradation ladder, in order:

- Both enumerable → ship as designed.
- Commands only → ship commands-only; the strip counts commands and the skills
  group is dropped.
- Neither → cut the feature. No composer work starts.

Unlike the MCP spec, no partial version of this is worth building blind: the
composer changes are the expensive part and they are worthless without entries
to show.

**Menu key handling collides with the composer.** The composer owns Enter and
likely arrow-key history. A handler that leaks after close makes Enter stop
sending — strictly worse than having no menu. The menu claims those keys only
while open, releases them on every close path (Escape, selection, emptied
query, blur), and the trigger-discipline test covers it.

**Descriptions are provider-authored and unbounded.** Skill descriptions in the
wild run to paragraphs. Rows clamp to one line with ellipsis; the full text is
not shown anywhere in this version.

## Future

- **Change detection.** If the provider gains a watcher, the snapshot contract
  already supports it with no change above the seam.
- **Fuzzy matching**, if long prefixed names prove annoying in practice.
- **Description on hover or in an expanded row**, once there is evidence a
  one-line clamp is losing something users need.

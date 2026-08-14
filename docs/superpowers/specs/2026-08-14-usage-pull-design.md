# hiiiid-code — Plan Usage by Pull

**Date:** 2026-08-14
**Status:** Design approved in chat; pending implementation plan.
**Supersedes:** the push-fed usage architecture in
[../plans/2026-08-14-push-fed-usage.md](../plans/2026-08-14-push-fed-usage.md),
which shipped against a source that does not carry the value it renders.

## Overview

The usage strip reads `Plan usage not reported` on a Claude subscription
account, before and after a send, and does so permanently. The cause is not a
missing refresh: it is that `rate_limit_event` — the event the strip is built
on — does not carry a utilization percentage at steady state, and the strip
renders nothing else.

This replaces the data source. Plan usage is **pulled** from the SDK's
structured usage response, on three triggers, and `rate_limit_event` is demoted
from data to a signal that a pull is due.

## Evidence

A live `rate_limit_event` on a subscription account, captured from the query
pump on 2026-08-14:

```json
{"status":"allowed","resetsAt":1786727400,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"out_of_credits",
 "isUsingOverage":false}
```

Three facts follow, and each is load-bearing.

**No `utilization`.** `SDKRateLimitInfo` (sdk.d.ts:4421) makes every field
except `status` optional. `toUsageWindow` correctly maps this to nothing, and
the strip correctly renders its empty state. The architecture, not the mapping,
is what is wrong.

**`resetsAt` is epoch seconds.** `1786727400` is 2026-08-14T17:10Z as seconds
and 1970-01-21 as milliseconds. `map-context.ts` declares it as milliseconds
and asserts so in a comment. Every window built from this event is therefore
filtered as already-reset by both `SessionManager.windowsFor` and
`ProviderUsage` — a second, independent cause of the same blank strip.

**The two sources scale utilization differently.** Anthropic's own VS Code
extension (`anthropic.claude-code-2.1.220`) computes
`Math.floor(e.utilization * 100)` from a `rate_limit_event`, and uses
`Math.min(100, Math.max(0, t))` unscaled from the structured usage response.
`rate_limit_event.utilization` is a 0–1 fraction; the structured response's is
already 0–100. Our mapper rounds the fraction, so it would have rendered 0% or
1% the moment a percentage did arrive. This bug is latent only because the
`resetsAt` bug hides it.

### What the first-party extension does

Two paths, neither of which is ours:

- `GET {BASE_API_URL}/api/oauth/usage` with OAuth headers, gated on
  `authMethod === 'claudeai'`, 5s timeout. No CLI, no session. This is why its
  numbers are available the instant the panel opens.
- `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`, the
  `get_usage` control request, for session-scoped reads.

It uses `rate_limit_event` only to compose warning text — *"You've used X% of
your…"*, *"Approaching…"*, *"You've hit your…"*. It never draws its usage bars
from it.

## Goals

- **Usage on open.** Real percentages after activation, with no session started
  and no message sent.
- **Usage that moves.** The number climbs as the plan is consumed, without a
  reload.
- **Every provider that exposes it.** One row per provider that can answer;
  providers that cannot are absent, not apologetic.

## Non-goals

- **`GET /api/oauth/usage`.** Considered and declined: sourcing an OAuth token
  from Claude Code's private credential store is a dependency on another
  product's undocumented internals. Revisit only as a deliberate decision, not
  as an optimization.
- **Polling on a timer.** A stale value between triggers is accepted. A timer
  is a second clock to keep correct, and the triggers below cover real
  movement.
- **Token counts.** The existing invariant stands: these surfaces show
  percentages only.
- **Cost, spend, and per-model breakdowns.** The structured response carries
  `session.total_cost_usd`, `model_usage`, `behaviors` and `extra_usage`. None
  of it is read.

## Data source

`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`
(sdk.d.ts:2521), returning `SDKControlGetUsageResponse` (sdk.d.ts:3351).

Two fields matter:

- `rate_limits_available: boolean` — false for API key, Bedrock, Vertex, and
  missing profile scope, with `rate_limits` null. A **positive** answer to "this
  account has no plan limits", where today the strip can only infer it from
  silence.
- `rate_limits` — `five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet`, each `{ utilization: number | null, resets_at: string |
  null }`, where `resets_at` is **ISO 8601** and `utilization` is already
  0–100.

`seven_day_oauth_apps`, `model_scoped[]` and `extra_usage` are not mapped.
`model_scoped` carries a server-supplied `display_name` and is the obvious
first extension if per-model windows are wanted later; it is left out now
because nothing in the current UI asks for it.

**On the name.** It is marked experimental and may change under any SDK bump.
Accepted deliberately: it is what Anthropic's own extension ships, it is typed,
and the alternative — parsing the rendered text of
`SDKLocalCommandOutputMessage` from `/usage` — trades a rename that fails
loudly for a layout change that fails silently with wrong numbers. The identifier
appears exactly once in the codebase, inside `ClaudeProvider.fetchUsage`. The
response is read through a structural `*Like` interface, as `ContextUsageLike`
already is, so an added or renamed field degrades to "no windows" rather than
throwing.

## Triggers

| Trigger | Mechanism | Serves |
|---|---|---|
| Activation | `probe()` — throwaway query, no session | usage on open |
| `rate_limit_event` | re-pull on the reporting session's live query | usage that moves |
| Turn end | re-pull on the same live query | backstop when no event fires |

Only activation spawns a subprocess, once per provider, on the same tick as the
existing `refreshModels` probe. The other two triggers run on a `Query` the
session already holds, so they cost one control request each and no process.

`rate_limit_event` is documented as *"emitted when rate limit info changes"*,
which is precisely the condition under which a re-pull is worth making. Reading
it as a signal rather than as data is what removes our dependency on the fields
it does not populate.

## Provider seam

`AgentProvider` gains one optional method, mirroring `fetchModels?`:

```ts
/**
 * Account/plan usage for a working directory, with NO session required.
 *
 * `undefined` is a positive answer — this account has no plan limits at all
 * (API key, Bedrock, Vertex) — and clears any persisted windows for the
 * provider. An empty array means limits exist but nothing is known yet.
 * Rejections propagate; the caller decides retry policy.
 */
fetchUsage?(cwd: string): Promise<UsageWindow[] | undefined>;
```

`AgentRun` gains the session-scoped equivalent, for the two live triggers:

```ts
/** Same contract as `AgentProvider.fetchUsage`, on this run's live query. */
usageWindows?(): Promise<UsageWindow[] | undefined>;
```

This reinstates a member name the push-fed plan deleted, with a different
contract: the old `AgentRun.usageWindows` was the *only* source and could not
answer before the first send, which is what made it read as an error after
every reload. Here it is one of three triggers, and the activation pull —
which needs no session — is what covers the case it could not.

A provider that implements neither never appears in the strip. No capability
flag, no settings, no per-provider configuration. `FakeProvider` implements both
from its existing scripted `FakeReports.windows`.

### AgentEvent

`{ kind: 'usage-window'; window: UsageWindow }` is **removed**. In its place:

```ts
/**
 * The provider believes its plan usage has moved. Carries no data: the
 * values come from a pull. Emitted on `rate_limit_event` and at turn end.
 */
| { kind: 'usage-stale' }
```

`toUsageWindow` and `RateLimitInfoLike` are deleted with it. `WINDOW_LABELS`
survives, keyed to the structured response's field names.

## Host

`SessionManager` keeps its `Map<providerId, Map<windowId, UsageWindow>>`, the
`usage.json` persistence and the `hydrate` seeding — all of which are correct
and stay. Two changes:

- **`refreshUsage(cwd)`**, modeled on `refreshModels`: fan out to providers
  implementing `fetchUsage`, catch each into a `console.warn`, emit
  `usage-windows` per provider, persist. Called fire-and-forget from the
  `ready` handler in `message-router.ts`, beside `refreshModels`. Never blocks
  activation.
- **`usageWindows(providerId, windows)`** replaces
  `usageWindow(providerId, window)` as the `SessionSink` method — a whole set
  rather than one window. `AgentSession` performs the pull itself on
  `usage-stale` and at turn end, then reports the result. The sink stays
  data-only: handing it an `AgentRun` to call back into would put provider
  I/O behind an interface whose other members are all plain state.

**Merge semantics differ by direction, and this is deliberate.** A pull is a
snapshot and **replaces** a provider's whole map; the old push upserted one
window at a time. Replacement is what lets a window disappear when the account
stops reporting it. The existing unchanged-value guard is kept, comparing whole
sets rather than single windows, so an identical re-pull still does not
re-render.

A pull resolving to `undefined` clears the provider's entry and persists the
clearance — otherwise an account that switched from subscription to API key
would show its last subscription numbers forever.

## Webview

Two changes, both already agreed:

- `UsageStrip` derives its rows from `state.usageByProvider` rather than
  `state.sessions`. A provider with usage but no open session is shown; a
  provider with a session but no usage is not.
- The strip **unmounts entirely** when no provider has a live window, rather
  than rendering an empty bordered bar. With API-key providers in the roster,
  the per-provider `Plan usage not reported` line would otherwise be permanent
  noise that no action can clear.

`ProviderUsage`'s empty branch is kept, not deleted: the `resetsAt > now` filter
runs per render, so a provider can empty out between renders and the branch must
not crash. It simply stops being reachable from a strip that has already
decided to render.

Everything else — `Ring`, `WindowChip`, the tooltip, the focusable `img` role,
the fixed `USAGE_WINDOW_ORDER` — is unchanged.

## Correctness fixes

Independent of the architecture, and worth landing first as their own commit
since they are live bugs against known-wrong values:

- `resetsAt` seconds → milliseconds.
- `utilization` scale: the structured response is 0–100 and must **not** be
  multiplied; only `rate_limit_event`'s is a fraction, and we stop reading it.

No `usage.json` migration is needed. Nothing valid was ever persisted — every
window written under the old code carries a 1970 `resetsAt` and is pruned on
read by `usageSnapshot`.

## Testing

- **Unit, mapper:** ISO `resets_at` parsing; `utilization: null` drops the
  window; unknown keys ignored; `rate_limits_available: false` yields
  `undefined`, distinct from `[]`.
- **Unit, provider:** an injected fake `query` asserts `fetchUsage` issues the
  control request and that the throwaway query is closed on both the success
  and rejection paths.
- **Unit, host:** `refreshUsage` fans out and emits, beside the existing
  `refreshModels` tests; a rejecting provider does not reject the fan-out; a
  pull returning `undefined` clears a previously persisted entry; an identical
  re-pull emits nothing.
- **DOM:** the three existing `Plan usage not reported` assertions invert to
  absence; a provider with windows and no session renders; a provider with a
  session and no windows does not; two reporting providers are labelled.
- **Mechanical:** `detect.mjs` over `usage-strip.tsx` per CLAUDE.md.

The temporary diagnostic in `claude-provider.ts`'s query pump is removed as part
of the first commit.

## Risks

**The experimental response shape changes.** Mitigated by the structural
`*Like` interface and by the fact that a missing field degrades to an absent
window. Detection is a silently empty strip, which is the same failure mode the
feature has today.

**The control request is slow or hangs at activation.** `probe()` closes its
query in a `finally`, and `refreshUsage` is fire-and-forget, so a hang costs a
leaked subprocess for the window's life but never blocks the panel. If that
proves real, a timeout belongs in `probe()`, where it would also protect
`fetchModels` and `listInvocables`.

**Two control requests per turn end on many concurrent sessions.** Each is a
control request on an existing process, not a spawn. If it shows up, the answer
is to coalesce per provider rather than per session — the host already keys
usage by provider, so the data model does not need to change.

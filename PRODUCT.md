# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A solo developer running two to four coding-agent sessions in parallel against the same repository, switching between them while turns are still running. The panel is a supervision surface: they read what agents are doing, answer permission requests, and steer with short messages. They are not writing code in it — the editor is right next to it, and it is where their attention returns.

## Product Purpose

Run several coding-agent conversations at once inside VS Code, in the secondary sidebar, without losing any of them to a window reload. Success is a developer keeping useful oversight of more concurrent agent work than a single-conversation tool allows.

## Positioning

Two things a neighbouring tool could not truthfully copy:

- **Concurrent sessions in split panes.** Several live agent conversations visible simultaneously in a resizable sidebar, each with its own model, effort level and permission mode.
- **It lives in the sidebar, not an editor tab.** The panel sits alongside the code rather than displacing it, which fixes the width budget at roughly 300–500px and makes every layout decision a narrow-column decision.

## Operating Context

- VS Code secondary sidebar, typically 300–500px wide, alongside an open editor.
- Long-running agent turns: the user reads and acts while text is still streaming in.
- The user's attention alternates between the editor and the panel, many times per turn.
- Tool-permission requests arrive unpredictably and block an agent until answered.
- A window reload is routine and must cost nothing.

## Capabilities and Constraints

- A roster of concurrent sessions, each with its own status, model, effort level and permission mode.
- Split panes over the visible subset of the roster, with a persisted layout.
- Tool-permission requests surfaced as cards in the transcript and answered there.
- Durable transcripts: per-session JSONL under `context.storageUri`, paged on demand.
- Two agent backends behind one interface: a scripted `FakeProvider` for tests and development, and the Claude Agent SDK for real work.
- **The extension host owns all state; the webview is a rendering client over `postMessage`.** `retainContextWhenHidden` is off, so the webview holds nothing durable and a reload is recovered by replaying host state.
- The webview loads no remote resources — no CDN scripts, styles, fonts or images. CSP is `default-src 'none'` with a per-load nonce.
- Out of scope: editing files directly, a terminal, anything duplicating VS Code's own chat UI.
- Vocabulary: *session* (one conversation), *pane* (a visible session), *roster* (all sessions), *transcript* (a session's items), *permission request* (a parked tool call).

## Brand Commitments

Name: HiiiiD Code. No logo, wordmark or palette is committed beyond the extension icon at `media/icon.svg`. The panel is expected to read as part of VS Code rather than as a guest inside it.

## Evidence on Hand

- Spec: `docs/superpowers/specs/2026-08-13-vscode-agent-manager-design.md`
- Plan: `docs/superpowers/plans/2026-08-13-vscode-agent-manager.md`
- Architecture and invariants: `CLAUDE.md`
- No usage data, testimonials, benchmarks or customer evidence exists. Future work must not fabricate any.

## Product Principles

1. **The host is the source of truth.** Anything the webview shows is a render of host state; nothing durable lives in the client.
2. **Supervision over authorship.** The panel exists to watch, approve and steer agents, not to become an editor.
3. **A narrow column is the design constraint, not an afterthought.** Every surface is composed for ~300px first.
4. **Interruptions are the normal case.** Streaming turns, arriving permission requests and reloads are routine, so no surface may assume a settled state.
5. **Errors are state, never exceptions.** A failure becomes a visible session status and a transcript item, never a lost message.

## Accessibility & Inclusion

Native VS Code expectations, held as a real bar: every control keyboard reachable with a visible focus ring, the active VS Code theme respected through theme tokens (light, dark and high-contrast), and the panel legible at the default sidebar width. No stricter formal standard is committed; treat WCAG conformance as undecided rather than claimed.

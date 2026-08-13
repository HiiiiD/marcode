# HiiiiD Code

Run several coding-agent sessions at once, in resizable split panes, in VS Code's
secondary sidebar. Tool-permission requests show up as cards in the transcript and are
answered from the UI. Transcripts survive a window reload.

## Features

- A roster of concurrent agent sessions, each its own conversation with its own status,
  model, effort level and permission mode.
- Split panes over the visible subset of that roster, with a persisted layout.
- Tool-permission requests surfaced as cards in the transcript, answered from the UI.
- Durable transcripts, paged on demand, that survive a window reload.

## Setup: move the panel to the secondary sidebar

VS Code extensions cannot place a view in the secondary sidebar directly, so this is a
one-time manual step:

1. Open the secondary sidebar — **View → Appearance → Secondary Side Bar**, or `Ctrl+Alt+B`.
2. Drag the **HiiiiD Code** icon from the activity bar into the secondary sidebar.
3. Widen it by dragging its inner edge — split panes need the room.

VS Code stores this per profile and workspace, so it only has to be done once. The
extension also ships a walkthrough with the same steps — open it from the Command
Palette with **Get Started: Open Walkthrough...** and pick "Set up the HiiiiD Code panel".

## Requirements

The Claude Agent SDK backend shells out to the `claude` CLI. That CLI must already be
installed and authenticated before starting a session — this extension does not manage
or prompt for authentication itself.

## What v1 does not do

- No Codex or OpenCode provider backends — only the Claude Agent SDK and a scripted
  provider used for tests and development.
- No transcript retention policy — transcripts accumulate under extension storage with
  no automatic pruning.
- No virtualized scrolling in the transcript view.

## Platform note

The packaged build currently targets Windows x64: the Claude Agent SDK ships its native
binaries as separate per-platform optional dependencies, and only the Windows x64
package is installed in this build environment.

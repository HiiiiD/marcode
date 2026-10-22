# Change Log

## [Unreleased]

Initial development. Not yet released.

- Concurrent agent sessions in the secondary sidebar, in resizable split panes.
- Tool-permission requests answered from the transcript.
- Transcripts persisted per session, restored across a window reload.
- Two backends: a scripted fake provider, and the Claude Agent SDK.
- `/mcp` in a pane (sidebar and terminal) opens that session's MCP servers: add (stdio, HTTP, SSE on Claude, or a pasted JSON snippet) to the repo or global config, delete, reconnect, sign in where the provider supports it, and restart the session to load a config change. Replaces the MCP button in the session header.
- New `claude.claudeAiConnectors` setting, default `false`: Marcode's Claude sessions no longer load claude.ai connectors unless you turn it on.

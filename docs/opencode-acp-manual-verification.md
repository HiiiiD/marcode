# OpenCode (ACP) manual verification

The unit and DOM suites cover the wire mapping against a fixture
(`src/test/fixtures/opencode-acp-frames.json`) and a scripted ACP peer, but
nothing in the automated suite spawns a real `opencode` process. This is the
checklist to run by hand, against a real install, before shipping a change
that touches `src/providers/acp/` or `src/providers/opencode/`.

## Setup

1. Install `opencode` (tested against **1.18.18**) and log in
   (`opencode auth login`), so the model list is real.
2. Confirm `opencode acp` starts and speaks ACP: `opencode acp` should sit
   waiting on stdin rather than exit.
3. In VS Code, set `hiiiidCode.enabledProviders` to include `"opencode"`
   (it does by default) and, if `opencode` is not on `PATH`, point
   `hiiiidCode.opencode.path` at the binary.
4. Reload the window so `activate()` re-probes providers.

Record a pass/fail and any notes for each item below.

## Checklist

1. **New session streams text and reasoning; model switcher lists real
   models.** Start a new OpenCode session, send a prompt that makes the model
   think out loud. Confirm reasoning/thought text and the final message both
   stream into the transcript, and that the model dropdown lists the models
   `opencode` itself reports (not a hardcoded list).
   - Result: OK
   - Notes: ___

2. **Switching the model mid-session takes effect on the next turn.** Change
   the model in an existing session, send another prompt, and confirm the
   reply reflects the new model (e.g. ask the model to name itself, or watch
   for an obvious quality/latency difference).
   - Result: OK
   - Notes: ___

3. **`plan` mode refuses an edit; `default` performs one.** Switch the
   session to `plan` mode and ask for a file edit — confirm it is refused or
   only describes the change. Switch to `default` (build) and ask again —
   confirm the edit actually lands on disk.
   - Result: OK
   - Notes: ___

4. **Permission cards appear and both allow and deny work.** In the
   project's `opencode.json`, set `"permission": { "edit": "ask", "bash":
   "ask" }`. Ask for an edit: confirm a permission card appears in the
   transcript. Click allow — confirm the edit proceeds. Repeat and click
   deny — confirm the edit is refused and the agent is told so.
   - Result: ___
   - Notes: ___

5. **`bypass` skips the card; `dontAsk` auto-rejects.** Set the session's
   permission mode to `bypass` and ask for an edit — confirm no card appears
   and the edit proceeds anyway. Set it to `dontAsk` and ask for an edit —
   confirm no card appears and the call comes back rejected (not silently
   dropped).
   - Result: ___
   - Notes: ___

6. **Context ring fills; caption reads `used / window`.** Send enough turns
   to move the context ring visibly. Open its breakdown popover and confirm
   the caption is `usedTokens / windowTokens`, not a bare percentage and not
   a token count standing in for one.
   - Result: OK
   - Notes: ___

7. **Reload restores the session in the same directory.** With an active
   OpenCode session, reload the VS Code window. Confirm the session
   reappears (status, transcript) and that a follow-up prompt runs in the
   same working directory it started in — not a fresh one.
   - Result: ___
   - Notes: ___

8. **The MCP line renders and reads correctly.** With at least one MCP
   server configured in the user's `opencode.json`, open the session picker
   and confirm the MCP explanation line appears in its MCP group for a
   visible OpenCode session, and that its wording does not claim MCP is
   unsupported or disabled (it works — this project just cannot report which
   servers are live; see `agentCapabilities.mcpCapabilities` in the
   `initialize` reply).
   - Result: ___
   - Notes: ___

9. **Confirm the reject option's real `optionId` and `kind`.** The spike
   capture in `src/test/fixtures/opencode-acp-frames.json`
   (`requestPermission.options`) was truncated after "Always allow" and its
   `reject` entry (`{ "optionId": "reject", "kind": "reject_once" }`) was
   filled in by inference, not observed. Trigger a real permission request
   from `opencode acp` (e.g. via stderr/protocol logging, or a temporary
   `console.error(JSON.stringify(params))` in the `requestPermission`
   handler) and read the actual `requestPermission` options array off the
   wire. If the reject option's `optionId` or `kind` differs from the
   fixture, correct the fixture (and re-run `yarn test:unit` to confirm
   `src/providers/acp/permissions.ts`'s tests still pass against the real
   shape).
   - Result: ___
   - Notes: ___

10. **Confirm the `session/load` reply shape.** The spike never observed a
    clean `session/load` response — the code path assumes a reply shaped like
    `newSession`'s (`{ configOptions?: ... }`, no fresh `sessionId`).
    Reproduce a `session/load` call (e.g. reopen a session whose
    `threadScope` allows a load rather than a replay-reseed, or instrument
    `AcpRun`'s `loadSession` call) and confirm the reply actually matches
    that shape. Note any field this project does not currently read.
    - Result: ___
    - Notes: ___

## Known, deliberate gaps (not bugs to chase during this pass)

- `threadScope` is `'cwd'`: a `session/load` from a directory other than the
  one that created the session replays the whole history and then never
  answers (measured, hung 5+ minutes on 1.18.18). Relocating a session
  therefore reseeds it by replaying the transcript rather than resuming
  natively — this is intentional, not something to "fix" during this pass.
- `fetchUsage`/plan usage windows are unimplemented: ACP carries no
  plan-usage data, so the usage strip simply has nothing to show for
  OpenCode sessions.
- Question cards are out of scope for v1.
- `session/fork` is advertised by OpenCode but unused by this project.

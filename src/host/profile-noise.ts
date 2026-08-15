/**
 * Detection of PowerShell **profile** load failures leaking into a command's
 * own output.
 *
 * Codex runs every shell command on Windows as
 * `"C:\Program Files\PowerShell\7\pwsh.exe" -Command "…"` — with no
 * `-NoProfile` (measured on codex-cli 0.147.0; see `providers/codex/wire.ts`).
 * The user's profile therefore loads once per command, in a host whose stdout
 * is redirected and which has no virtual terminal. Anything in that profile
 * needing a real console — PSReadLine above all — throws, and its error frame
 * is captured as part of the command's output. The command still exits 0, so
 * nothing here is a failure; the cost is that the noise is fed to the agent as
 * if it were the result.
 *
 * Nothing this extension passes to `codex app-server` can change that
 * invocation, so the only fix belongs in the user's profile. Detecting it is
 * how we get to tell them.
 *
 * No `vscode` import: this is pure, and unit-tested outside the host.
 */

/**
 * SGR colour codes, which PowerShell interleaves *mid-token* — a real capture
 * puts `\u001b[0m` between the cmdlet's colon and the path that follows it.
 * Stripped before matching so the frame is one contiguous string.
 */
const ANSI = /\u001b?\[[0-9;]*m/g;

/**
 * The frame PowerShell prints when a statement inside a profile throws:
 * `<Cmdlet>: <path>:<line>` (7+) or `<Cmdlet> : <path>:<line>` (5.1).
 *
 * Anchored on the frame rather than on the message, because the message is
 * localized — the capture this was built from says "Handle non valido." on an
 * Italian install — and rather than on the offending cmdlet names, because
 * those appear verbatim in any profile an agent merely reads.
 *
 * The path must end in a file that IS a profile: `<host>_profile.ps1` (e.g.
 * `Microsoft.PowerShell_profile.ps1`, `Microsoft.VSCode_profile.ps1`) or a
 * bare `profile.ps1` (the AllHosts profile). A user script that throws is the
 * agent's problem, not a profile the user should be told to guard.
 */
const FRAME = /^[^\s:]+ ?: ((?:[A-Za-z]:)?[^\r\n:]*?(?:[\\/][^\\/\r\n]*?)?(?:_profile|profile)\.ps1):\d+/m;

/**
 * The profile a command's output blames, or undefined when the output is not a
 * profile failure at all.
 *
 * `undefined` in, `undefined` out — a tool that reported no output cannot be
 * evidence of anything.
 */
export function profileNoiseIn(output: string | undefined): string | undefined {
  if (!output) { return undefined; }
  const match = FRAME.exec(output.replace(ANSI, ''));
  return match?.[1];
}

/**
 * The fix, ready to paste into the profile the detector named: run the
 * console-only setup only when there IS a console.
 *
 * `SupportsVirtualTerminal` alone is not enough — a host can claim it and
 * still have its output redirected, which is the exact case here — so the
 * redirection checks are part of the condition, not an alternative to it.
 */
export const PROFILE_GUARD_SNIPPET = [
  'if ($Host.UI.SupportsVirtualTerminal -and',
  '    -not [Console]::IsOutputRedirected -and',
  '    -not [Console]::IsInputRedirected) {',
  '  # Console-only setup goes here: PSReadLine options, predictors, prompt.',
  '  Set-PSReadLineOption -PredictionSource HistoryAndPlugin',
  '  Set-PSReadLineOption -PredictionViewStyle ListView',
  '}',
].join('\n');

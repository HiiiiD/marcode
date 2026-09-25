/**
 * One line telling the model where it is running, prepended to a fresh
 * session's very first message — not to every turn, and not to a resumed
 * session, whose transcript already carries it. Shared across providers so
 * the model gets the same framing whichever backend is behind the session;
 * a Claude-only `systemPrompt` option would have left every other backend
 * silent on it.
 */
export const MARCODE_INTRO =
  '<marcode-context>You are running inside Marcode, a VS Code extension that hosts you in '
  + 'a resizable split-pane session alongside other concurrent agent sessions.</marcode-context>';

/** Prepends `MARCODE_INTRO` ahead of `body`, once, for a session's first outgoing message. */
export function withMarcodeIntro(body: string, alreadyIntroduced: boolean, isResume: boolean): string {
  if (alreadyIntroduced || isResume) { return body; }
  return `${MARCODE_INTRO}\n\n${body}`;
}

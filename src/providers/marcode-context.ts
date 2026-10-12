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

/**
 * Claude-only addendum: its harness ships a built-in SendMessage/ListAgents that
 * can reach other Marcode sessions behind the panel's back.
 */
export const CLAUDE_INTRO_NOTE =
  'To message another session use marcode__send_message (find sessions with marcode__list_sessions, '
  + 'never ListAgents); the built-in SendMessage is only for subagents you spawned yourself.';

/** Prepends `MARCODE_INTRO` (plus an optional provider `note`) ahead of `body`, once, for a session's first outgoing message. */
export function withMarcodeIntro(body: string, alreadyIntroduced: boolean, isResume: boolean, note?: string): string {
  if (alreadyIntroduced || isResume) { return body; }
  const intro = note ? MARCODE_INTRO.replace('</marcode-context>', ` ${note}</marcode-context>`) : MARCODE_INTRO;
  return `${intro}\n\n${body}`;
}

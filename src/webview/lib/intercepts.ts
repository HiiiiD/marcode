/**
 * Slash commands the panel answers itself instead of forwarding to the agent.
 *
 * The agent's own `/context` prints a wall of text into the transcript — in a
 * 300px column that is unreadable, and the panel already holds the same
 * numbers as structured state. So the composer claims the command and opens
 * the surface built for it.
 *
 * Deliberately a table rather than a special case: `/cost` and `/status` have
 * the same problem and the same answer, and each is one entry plus the
 * surface it names.
 */
export type InterceptId = 'context';

const TABLE: Record<string, InterceptId> = {
  '/context': 'context',
};

/**
 * The surface `text` should open instead of being sent, or `undefined` when
 * the message belongs to the agent.
 *
 * Only a bare command matches. A command carrying arguments is asking for
 * something this panel cannot do anything with, so it goes to the agent
 * untouched — as does anything that merely starts with an intercepted
 * command's characters (`/contextual-help`).
 */
export function interceptFor(text: string): InterceptId | undefined {
  return TABLE[text.trim()];
}

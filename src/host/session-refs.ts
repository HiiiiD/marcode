import type { RefKind, TranscriptItem } from '../protocol/messages';

/** One resolved reference, ready to be appended to a prompt. */
export interface ResolvedBlock { title: string; kind: RefKind; text: string }

/**
 * The text a reference resolves to, or `undefined` when the source has
 * nothing to give.
 *
 * Searches backwards, so "most recent" costs no sort. `excludeItemId` is the
 * live session's currently-open assistant item: an in-flight answer is never
 * a candidate, which is what lets a reference resolve against a session that
 * is still running without ever pulling half a sentence.
 *
 * `plan` deliberately searches across turns rather than stopping at the last
 * user message. A plan is often several turns old by the time it is handed
 * off, and a rule that found nothing in that case would send the user looking
 * for a payload that is plainly on screen.
 */
export function findPayload(
  items: TranscriptItem[], kind: RefKind, excludeItemId?: string,
): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.id === excludeItemId) { continue; }
    if (kind === 'message') {
      if (item.role === 'assistant' && item.text.trim().length > 0) {
        return item.text;
      }
      continue;
    }
    // Same emptiness guard as the message branch above: an empty plan resolves
    // to `''`, which renders as an empty disclosure chip rather than falling
    // through to the previous plan or being reported as missing.
    if (item.role === 'tool' && item.state === 'ok' && item.tool.kind === 'plan'
      && item.tool.text.trim().length > 0) {
      return item.tool.text;
    }
  }
  return undefined;
}

/**
 * The prose as typed, with each payload appended after it as a delimited
 * block.
 *
 * Positional rather than substitutional: the composer's `@agent-2 plan` token
 * stays readable in the text and the content follows it, so there is no
 * placeholder scheme that a user editing their own message could break.
 */
export function composePrompt(prose: string, blocks: ResolvedBlock[]): string {
  if (blocks.length === 0) { return prose; }
  const rendered = blocks.map((b) =>
    `--- ${b.kind} from ${b.title} ---\n${b.text}\n--- end ${b.kind} from ${b.title} ---`);
  return [prose, ...rendered].join('\n\n');
}

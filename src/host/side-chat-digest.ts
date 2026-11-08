import type { TranscriptItem } from '../protocol/messages';
import { fitLines, lineFor } from './replay';

export const SIDE_CHAT_HEADER = [
  'The following is from a side chat the user ran beside this conversation, which you did not take part in.',
  'They are bringing its outcome back. It is context, not a task.',
].join(' ');

const DEFAULT_BUDGET = 12_000;

/** What was said in a side chat after it was forked, newest kept when over budget; empty when nothing was. */
export function buildSideChatDigest(
  items: TranscriptItem[], forkedItemCount: number, budgetChars = DEFAULT_BUDGET,
): string {
  const lines = items.slice(forkedItemCount).map(lineFor).filter((l): l is string => l !== undefined);
  return fitLines(`${SIDE_CHAT_HEADER}\n\n`, lines, budgetChars);
}

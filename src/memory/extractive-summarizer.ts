import type { TranscriptItem } from '../protocol/messages';
import type { Summarizer } from './types';

const MAX_SNIPPET_LENGTH = 200;

/**
 * v1's `Summarizer`: no LLM call, no added latency or cost on session
 * archive. First user message (truncated) plus a message count — enough for
 * a search snippet and a browse-list row. An LLM-backed `Summarizer` is a
 * drop-in replacement behind the same one-method contract.
 */
export class ExtractiveSummarizer implements Summarizer {
  async summarize(items: TranscriptItem[]): Promise<string> {
    const firstUser = items.find((i): i is TranscriptItem & { role: 'user'; text: string } => i.role === 'user');
    const label = items.length === 1 ? 'message' : 'messages';
    const suffix = `(${items.length} ${label})`;
    if (!firstUser || firstUser.text.length === 0) {
      return `Untitled session ${suffix}`;
    }
    const text = firstUser.text.length > MAX_SNIPPET_LENGTH
      ? `${firstUser.text.slice(0, MAX_SNIPPET_LENGTH)}…`
      : firstUser.text;
    return `${text} ${suffix}`;
  }
}

import type { SessionDigest } from '../../memory/digest';
import type { TranscriptItem } from '../../protocol/messages';

export interface ChainedSummarizer {
  summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest>;
  concurrency?: number;
}

/** No cooldown on purpose: a failed entry is retried on every call, so a recovered plan is picked up immediately. */
export class FallbackSummarizer implements ChainedSummarizer {
  readonly concurrency: number | undefined;

  constructor(private readonly chain: readonly ChainedSummarizer[]) {
    this.concurrency = chain[0]?.concurrency;
  }

  async summarize(items: TranscriptItem[], base: SessionDigest): Promise<SessionDigest> {
    let last: unknown = new Error('no summarizer configured');
    for (const summarizer of this.chain) {
      try {
        return await summarizer.summarize(items, base);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}

import type { TranscriptItem } from '../../protocol/messages';

// `composePrompt` appends resolved refs after the prose; recalling them would
// resend their bodies as if the user had typed them.
const BLOCK_START = /\n\n--- \w+ from /;

export function promptHistory(items: readonly TranscriptItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.role !== 'user' || item.from) { continue; }
    const carriesBlocks = (item.refs?.length ?? 0) > 0 || (item.fileRefs?.length ?? 0) > 0;
    const prose = carriesBlocks ? item.text.split(BLOCK_START)[0] : item.text;
    if (!prose.trim() || out[0] === prose) { continue; }
    out.unshift(prose);
  }
  return out;
}

import { useEffect, useState } from 'react';
import { CornerDownRightIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMessageScroller } from '@/components/ui/message-scroller';
import { activeSubagents } from './active-subagents';
import { formatElapsed } from './subagent-window';
import type { TranscriptItem } from '../../protocol/messages';

/**
 * The header's answer to "something is running — where is it?".
 *
 * A subagent's card is the one transcript item that can be minutes old and
 * still be the live edge of the session, so on a long turn it scrolls out of
 * reach while everything it says is still current. This names what is
 * running, times it, and reveals it — from the header, which never scrolls
 * away, unlike the composer or the card itself.
 *
 * Mounted next to `StatusBadge` rather than replacing it: that badge is an
 * `aria-live` region whose announcements depend on it staying mounted across
 * status changes, and swapping it for a button would tear the region down
 * exactly when the session is busiest. Both are `shrink-0`; the title and the
 * folder name beside them already truncate.
 *
 * Renders nothing when nothing is running, which is most of the time — a
 * control that is permanently present and permanently inert is one more thing
 * to read past in a 300px column.
 */
export function ActiveSubagentBadge({ items }: { items: TranscriptItem[] }) {
  // Which one the NEXT click reveals. Kept as a plain counter and taken
  // modulo the live list: a subagent can finish between two clicks, and an
  // index stored against a list that has since changed length would either
  // go out of range or silently point at a different agent.
  const [cursor, setCursor] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const { scrollToMessage } = useMessageScroller();

  const active = activeSubagents(items);
  const count = active.length;

  // One interval while anything is running, cleared the moment nothing is.
  // A row reading "4m 12s" that never moves is indistinguishable from a hang,
  // which is the specific doubt this badge exists to answer.
  useEffect(() => {
    if (count === 0) { return; }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [count]);

  if (count === 0) { return null; }

  const index = cursor % count;
  const target = active[index];
  const elapsed = formatElapsed(Math.max(0, now - target.ts));
  // `1/2`, not `2 agents`: the user is about to be taken somewhere, so the
  // badge names the destination and lets the count say there are others,
  // rather than naming a group nobody can jump to.
  const position = count > 1 ? ` ${index + 1}/${count}` : '';

  return (
    <Button
      variant="ghost"
      size="sm"
      // Overrides the size variant's padding and gap, never its height —
      // the same rule tool-card.tsx and subagent-card.tsx follow.
      className="h-6 shrink-0 gap-1 px-1.5 font-normal text-[0.7rem]"
      aria-label={`Scroll to running subagent ${target.agent}, ${elapsed}${
        count > 1 ? ` (${index + 1} of ${count})` : ''
      }`}
      onClick={() => {
        scrollToMessage(target.itemId, { align: 'center' });
        setCursor((c) => c + 1);
      }}
    >
      <CornerDownRightIcon aria-hidden />
      <span className="max-w-24 truncate font-medium">{target.agent}{position}</span>
      <span className="shrink-0 text-muted-foreground">{elapsed}</span>
    </Button>
  );
}

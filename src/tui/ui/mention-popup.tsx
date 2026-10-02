import type { FileMentionPayload } from '../../client-core/mentions/file-mentions';
import type { MentionOption } from '../../client-core/mentions/mention-menu';

import { Surface } from './surface';

const MAX_ROWS = 8;

export function MentionPopup({ rows, index }: { rows: MentionOption<FileMentionPayload>[]; index: number }) {
  const start = Math.max(0, Math.min(index - MAX_ROWS + 1, rows.length - MAX_ROWS));
  return (
    <Surface tone="menu" padX={1} flexDirection="column" flexShrink={0}>
      {rows.slice(start, start + MAX_ROWS).map((row, i) => (
        <text key={row.id} attributes={start + i === index ? 1 : 0}>
          {`${start + i === index ? '›' : ' '} ${row.baseToken}`}
        </text>
      ))}
    </Surface>
  );
}

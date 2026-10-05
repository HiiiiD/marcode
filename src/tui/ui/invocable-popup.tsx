import type { Invocable } from '../../protocol/messages';
import { truncateName } from '../../client-core/invocables/invocable-menu';
import { Surface } from './surface';
import { useTokens } from './tokens/tokens-provider';

const MAX_ROWS = 8;

export function InvocablePopup({ rows, overflow, index }: { rows: Invocable[]; overflow: number; index: number }) {
  const tokens = useTokens();
  const muted = tokens?.textMuted ?? 'gray';
  const start = Math.max(0, Math.min(index - MAX_ROWS + 1, rows.length - MAX_ROWS));
  return (
    <Surface tone="menu" padX={1} flexDirection="column" flexShrink={0}>
      {rows.slice(start, start + MAX_ROWS).map((row, i) => {
        const active = start + i === index;
        return (
          <text key={`${start + i}-${row.name}`} attributes={active ? 1 : 0}>
            {`${active ? '›' : ' '} /${truncateName(row.name)}`}
            {row.description ? <span fg={muted}>{`  ${row.description}`}</span> : null}
          </text>
        );
      })}
      {overflow > 0 ? <text fg={muted}>{`  ${overflow} more — keep typing to narrow`}</text> : null}
    </Surface>
  );
}

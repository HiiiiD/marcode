import { stripLines, usageRows, windowLineText } from '../../client-core/usage-format';
import { useTuiStore } from './store';
import { useTheme } from './termcn/hooks/use-theme';
import { SPINNER, useTick } from './use-ticker';

export function UsageStrip({ width, maxLines }: { width: number; maxLines: number }) {
  const { state, refreshUsage } = useTuiStore();
  const theme = useTheme();
  const now = Date.now();
  const rows = usageRows(
    state.usageByProvider,
    (id) => state.usageDisplayNames[id] ?? state.catalog.find((p) => p.id === id)?.displayName ?? id,
    now,
  );
  // The countdown reads the clock at render time; the shared ticker is what re-renders it while visible.
  const tick = useTick(rows.length > 0);
  if (rows.length === 0 || maxLines <= 0) { return null; }
  const muted = theme.colors.mutedForeground;
  const header = state.usageRefreshing ? `${SPINNER[tick % SPINNER.length]} refreshing` : 'usage  ^G refresh';
  return (
    <box flexDirection="column" flexShrink={0} border={['top']} borderStyle="single" borderColor={theme.colors.border} onMouseDown={refreshUsage}>
      <text fg={muted} wrapMode="none">{header.slice(0, width)}</text>
      {stripLines(rows, width, maxLines).map((l, i) => (l.kind === 'provider'
        ? <text key={i} wrapMode="none">{l.text}</text>
        : <text key={i} fg={muted} wrapMode="none">{windowLineText(l.line)}</text>))}
    </box>
  );
}

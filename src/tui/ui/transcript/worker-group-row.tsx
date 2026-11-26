import { subagentLabel, summarizeSubagent } from '../../../client-core/subagent-window';
import { activitySignature, workerState, type WorkerState } from '../../../client-core/worker-status';
import type { ToolItem } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { useLastChanges } from '../use-last-change';
import { useTick } from '../use-ticker';
import { RowLabel } from './row-label';

const TALLY: WorkerState[] = ['needs-you', 'failed', 'quiet', 'running', 'done'];
const TALLY_WORDS: Record<WorkerState, string> = { 'needs-you': 'need you', failed: 'failed', quiet: 'quiet', running: 'running', done: 'done' };

/** A `spawn_collaborators` team on one line: how many, who, and how they are doing. */
export function WorkerGroupRow(props: { items: ToolItem[]; open: boolean; selected: boolean }) {
  const theme = useTheme();
  const muted = theme.colors.mutedForeground;
  useTick(props.items.some((i) => i.state === 'running'));
  const now = Date.now();
  const changes = useLastChanges(props.items.map((item) => ({ id: item.id, signature: activitySignature(item) })));
  const states = props.items.map((item) => workerState(item, summarizeSubagent(item, now).blocked, now, changes.get(item.id) ?? now));
  const tone: Record<WorkerState, string> = {
    'needs-you': theme.colors.primary, quiet: theme.colors.warning, running: muted, failed: theme.colors.error, done: theme.colors.success,
  };
  const tally = TALLY.map((st) => [st, states.filter((x) => x === st).length] as const).filter(([, n]) => n > 0);
  return (
    <box flexDirection="row" gap={1} maxWidth={100}>
      <text fg={muted} flexShrink={0}>⁂</text>
      <RowLabel text="Team" selected={props.selected} />
      <text flexShrink={0}>{`${props.items.length} workers`}</text>
      <box flexGrow={1} flexShrink={100} minWidth={0} height={1} overflow="hidden">
        <text fg={muted} wrapMode="none">{`· ${props.items.map(subagentLabel).join(', ')}`}</text>
      </box>
      <text flexShrink={0} wrapMode="none">
        {tally.map(([st, n], i) => <span key={st} fg={tone[st]}>{`${i > 0 ? '  ' : ''}${n} ${TALLY_WORDS[st]}`}</span>)}
      </text>
      <text fg={muted} flexShrink={0}>{props.open ? '▾' : '▸'}</text>
    </box>
  );
}

import { describeTool } from '../../../client-core/tool-render';
import {
  formatElapsed, isBackgroundDispatch, subagentLabel, summarizeSubagent, windowChildren,
} from '../../../client-core/subagent-window';
import {
  activitySignature, quietFor, statusWords, workerFailure, workerState, type WorkerState,
} from '../../../client-core/worker-status';
import type { ToolItem } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { useLastChange } from '../use-last-change';
import { useTick } from '../use-ticker';
import { Collapsible } from './collapsible';
import { ToolCard } from './tool-card';
import { RowLabel } from './row-label';
import { TOOL_GLYPHS } from './tool-glyphs';

export function SubagentCard(props: { item: ToolItem; open: boolean; userClosed: boolean; selected: boolean }) {
  const { item } = props;
  const theme = useTheme();
  const children = item.children ?? [];
  const now = Date.now();
  const summary = summarizeSubagent(item, now);
  const changedAt = useLastChange(activitySignature(item));
  const hosted = item.tool.kind === 'subagent' && item.tool.childSessionId !== undefined;
  const wstate = hosted ? workerState(item, summary.blocked, now, changedAt) : undefined;
  const expanded = props.open || (summary.blocked && !props.userClosed);
  // A worker's status must move on its own (Running → Quiet for 1m); a built-in one only shows a clock once opened.
  useTick(item.state === 'running' && (expanded || hosted));
  const shown = windowChildren(children);
  const muted = theme.colors.mutedForeground;
  const tone: Record<WorkerState, string> = {
    'needs-you': theme.colors.primary,
    quiet: theme.colors.warning,
    running: muted,
    failed: theme.colors.error,
    done: theme.colors.success,
  };
  const model = item.tool.kind === 'subagent' && item.tool.model ? ` · ${item.tool.model}` : '';
  const counts = `${summary.toolCount} ${summary.toolCount === 1 ? 'tool' : 'tools'} · ${formatElapsed(summary.elapsedMs)}${model}`;
  const failure = wstate ? workerFailure(item, wstate) : undefined;
  return (
    <Collapsible
      open={expanded}
      header={(
        <>
          <text fg={muted} flexShrink={0}>{TOOL_GLYPHS.bot}</text>
          {wstate ? (
            // The session id is not something to read at a glance; the status starts on the tools' target column.
            <>
              <RowLabel text="Worker" selected={props.selected} />
              <text fg={tone[wstate]} flexShrink={0}>{statusWords(wstate, quietFor(item, now, changedAt))}</text>
              <box flexGrow={1} flexShrink={100} minWidth={0} height={1} overflow="hidden">
                <text fg={muted} wrapMode="none">{`· ${counts}`}</text>
              </box>
            </>
          ) : (
            <>
              <RowLabel text="Agent" selected={props.selected} />
              <box flexShrink={1} minWidth={0} height={1} overflow="hidden">
                <text wrapMode="none">{subagentLabel(item)}</text>
              </box>
              <box flexGrow={1} flexShrink={100} minWidth={0} height={1} overflow="hidden">
                <text fg={muted} wrapMode="none">{`· ${isBackgroundDispatch(item) ? 'Running in background' : counts}`}</text>
              </box>
              {summary.blocked ? <text fg={theme.colors.primary} flexShrink={0}>Needs you</text> : null}
            </>
          )}
          <text fg={muted} flexShrink={0}>{expanded ? '▾' : '▸'}</text>
        </>
      )}
    >
      {failure !== undefined ? <text fg={theme.colors.error} wrapMode="word">{failure}</text> : null}
      {children.length > shown.length ? <text fg={muted}>{`showing last ${shown.length} of ${children.length}`}</text> : null}
      {shown.map((child) => {
        if (child.role === 'tool') { return <ToolCard key={child.id} item={child} open={false} selected={false} headerOnly />; }
        if (child.role === 'permission') {
          const h = describeTool(child.tool);
          return (
            <text key={child.id} wrapMode="word">
              <span fg={theme.colors.warning}>{'? '}</span>
              {`${h.verb} ${h.primary} — ${child.state}`}
            </text>
          );
        }
        return null;
      })}
    </Collapsible>
  );
}

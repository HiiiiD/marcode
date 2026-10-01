import { TextAttributes } from '@opentui/core';
import { describeTool } from '../../../client-core/tool-render';
import {
  formatElapsed, isBackgroundDispatch, subagentLabel, summarizeSubagent, windowChildren,
} from '../../../client-core/subagent-window';
import type { ToolItem } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { useTick } from '../use-ticker';
import { Collapsible } from './collapsible';
import { ToolCard } from './tool-card';

export function SubagentCard(props: { item: ToolItem; open: boolean; userClosed: boolean; selected: boolean }) {
  const { item } = props;
  const theme = useTheme();
  const children = item.children ?? [];
  const summary = summarizeSubagent(item, Date.now());
  const expanded = props.open || (summary.blocked && !props.userClosed);
  // A closed card shows a frozen elapsed time; only an open running one needs to move.
  useTick(item.state === 'running' && expanded);
  const shown = windowChildren(children);
  const muted = theme.colors.mutedForeground;
  const model = item.tool.kind === 'subagent' && item.tool.model ? ` · ${item.tool.model}` : '';
  const text = isBackgroundDispatch(item)
    ? 'Running in background'
    : `${summary.toolCount} ${summary.toolCount === 1 ? 'tool' : 'tools'} · ${formatElapsed(summary.elapsedMs)}${model}`;
  return (
    <Collapsible
      open={expanded}
      selected={props.selected}
      header={(
        <>
          <text fg={muted} flexShrink={0}>{expanded ? '▾' : '▸'}</text>
          <box flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text attributes={props.selected ? TextAttributes.BOLD : TextAttributes.NONE} wrapMode="none">{subagentLabel(item)}</text>
          </box>
          <box flexGrow={1} flexShrink={100} minWidth={0} height={1} overflow="hidden">
            <text fg={muted} wrapMode="none">{text}</text>
          </box>
          {summary.blocked ? <text fg={theme.colors.primary} flexShrink={0}>Needs you</text> : null}
        </>
      )}
    >
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

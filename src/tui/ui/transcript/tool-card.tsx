import { TextAttributes } from '@opentui/core';
import { describeInput, describeOutput, describeTool } from '../../../client-core/tool-render';
import type { ToolItem } from '../../view/transcript-rows';
import { useTheme } from '../termcn/hooks/use-theme';
import { SPINNER, useTick } from '../use-ticker';
import { Collapsible } from './collapsible';
import { ToolBlocks } from './tool-blocks';
import { TOOL_GLYPHS } from './tool-glyphs';

export function ToolCard(props: { item: ToolItem; open: boolean; selected: boolean; headerOnly?: boolean }) {
  const { item } = props;
  const theme = useTheme();
  const header = describeTool(item.tool);
  const running = item.state === 'running';
  const failed = item.state === 'error';
  const tick = useTick(running);
  const server = item.tool.kind === 'mcp' ? item.tool.server : undefined;
  const glyph = running ? SPINNER[tick % SPINNER.length] : failed ? '✗' : TOOL_GLYPHS[header.glyph];
  const open = props.open && props.headerOnly !== true;
  const muted = theme.colors.mutedForeground;
  const output = open ? describeOutput(item.tool.kind, item.output, item.state) : [];
  return (
    <Collapsible
      open={open}
      selected={props.selected}
      header={(
        <>
          <text fg={failed ? theme.colors.error : muted} flexShrink={0}>{glyph}</text>
          {server ? <text fg={muted} flexShrink={0}>{`[${server}]`}</text> : null}
          <text attributes={props.selected ? TextAttributes.BOLD : TextAttributes.NONE} flexShrink={0}>{header.verb}</text>
          <box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden">
            <text fg={muted} wrapMode="none">{header.primary}</text>
          </box>
          {failed ? <text fg={theme.colors.error} flexShrink={0}>failed</text> : null}
          {props.headerOnly ? null : <text fg={muted} flexShrink={0}>{props.open ? '▾' : '▸'}</text>}
        </>
      )}
    >
      {open ? <ToolBlocks blocks={describeInput(item.tool)} /> : null}
      {output.length > 0 ? (
        <>
          <text fg={muted}>{failed ? 'Error' : 'Result'}</text>
          <ToolBlocks blocks={output} />
        </>
      ) : null}
      {open && running ? <text fg={muted}>Running…</text> : null}
    </Collapsible>
  );
}

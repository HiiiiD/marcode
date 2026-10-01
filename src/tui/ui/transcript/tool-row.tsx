import { clampLines, describeInput, describeOutput, type ToolBlock } from '../../../client-core/tool-render';
import type { ToolCall, ToolOutput } from '../../../protocol/messages';

function clamped(text: string): string[] {
  const c = clampLines(text, 12, 8);
  return c.hidden === 0 ? c.head : [...c.head, `… ${c.hidden} lines hidden …`, ...c.tail];
}

function blockLines(block: ToolBlock): { text: string; fg?: string }[] {
  switch (block.kind) {
    case 'note': return [{ text: block.text, fg: 'gray' }];
    case 'field': return [{ text: `${block.label}: ${block.value}`, fg: 'gray' }];
    case 'command': return [{ text: `$ ${block.text}` }];
    case 'path': return [{ text: block.path, fg: 'gray' }];
    case 'diff': return clamped(block.lines.join('\n')).map((text) => ({
      text, fg: text.startsWith('+') ? 'green' : text.startsWith('-') ? 'red' : undefined,
    }));
    case 'todos': return block.items.map((i) => ({ text: `[${i.status}] ${i.text}` }));
    case 'lines': return clamped(block.text).map((text) => ({ text, fg: block.tone === 'error' ? 'red' : undefined }));
    case 'json': return clamped(block.text).map((text) => ({ text }));
    case 'image': return [{ text: '[image]', fg: 'gray' }];
  }
}

export function ToolBody(props: { tool: ToolCall; output?: ToolOutput; state: 'running' | 'ok' | 'error' }) {
  const blocks = [...describeInput(props.tool), ...describeOutput(props.tool.kind, props.output, props.state)];
  const lines = blocks.flatMap(blockLines);
  return (
    <box flexDirection="column" paddingLeft={4}>
      {lines.map((l, i) => <text key={i} fg={l.fg} wrapMode="word">{l.text}</text>)}
    </box>
  );
}

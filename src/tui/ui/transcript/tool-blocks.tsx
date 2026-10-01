import { TextAttributes } from '@opentui/core';
import { clampLines, type ToolBlock } from '../../../client-core/tool-render';
import { useTheme } from '../termcn/hooks/use-theme';

interface Line { text: string; fg?: string; attributes?: number }

function clamped(text: string): string[] {
  const c = clampLines(text, 12, 8);
  return c.hidden === 0 ? c.head : [...c.head, `… ${c.hidden} lines hidden …`, ...c.tail];
}

const TODO_MARK = { completed: '✓', in_progress: '◉', pending: '○' } as const;

function blockLines(block: ToolBlock, c: { muted: string; ok: string; bad: string }): Line[] {
  switch (block.kind) {
    case 'note': return [{ text: block.text, fg: c.muted }];
    case 'field': return [{ text: `${block.label}: ${block.value}`, fg: c.muted }];
    case 'command': return [{ text: `$ ${block.text}` }];
    case 'path': return [{ text: block.path }, ...(block.hint ? [{ text: block.hint, fg: c.muted }] : [])];
    case 'diff': return clamped(block.lines.join('\n')).map((text) => ({
      text, fg: text.startsWith('+') ? c.ok : text.startsWith('-') ? c.bad : undefined,
    }));
    case 'todos': return block.items.map((i) => ({
      text: `${TODO_MARK[i.status]} ${i.text}`,
      ...(i.status === 'completed' ? { fg: c.muted, attributes: TextAttributes.STRIKETHROUGH } : {}),
      ...(i.status === 'in_progress' ? { attributes: TextAttributes.BOLD } : {}),
    }));
    case 'lines': return clamped(block.text).map((text) => ({ text, fg: block.tone === 'error' ? c.bad : undefined }));
    case 'json': return clamped(block.text).map((text) => ({ text }));
    case 'image': return [{ text: '[image]', fg: c.muted }];
  }
}

export function ToolBlocks(props: { blocks: ToolBlock[] }) {
  const theme = useTheme();
  const colors = { muted: theme.colors.mutedForeground, ok: theme.colors.success, bad: theme.colors.error };
  const lines = props.blocks.flatMap((b) => blockLines(b, colors));
  return (
    <box flexDirection="column">
      {lines.map((l, i) => <text key={i} fg={l.fg} attributes={l.attributes} wrapMode="word">{l.text}</text>)}
    </box>
  );
}

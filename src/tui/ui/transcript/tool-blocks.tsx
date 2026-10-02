import { TextAttributes } from '@opentui/core';
import { clampLines, type ToolBlock } from '../../../client-core/tool-render';
import { useTheme } from '../termcn/hooks/use-theme';
import type { TuiTokens } from '../tokens/derive-tokens';
import { useTokens } from '../tokens/tokens-provider';
import { DiffBlock } from './diff-block';
import { hunksAreWellFormed, MAX_NATIVE_DIFF_LINES } from './diff-view';
import { filetypeOf } from './filetype';

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

export function nativeDiff(block: ToolBlock, tokens: TuiTokens | undefined): string | undefined {
  if (!tokens || block.kind !== 'diff' || block.unified === undefined) { return undefined; }
  if (block.lines.length > MAX_NATIVE_DIFF_LINES || !hunksAreWellFormed(block.unified)) { return undefined; }
  return block.unified;
}

export function ToolBlocks(props: { blocks: ToolBlock[] }) {
  const theme = useTheme();
  const tokens = useTokens();
  const colors = { muted: theme.colors.mutedForeground, ok: theme.colors.success, bad: theme.colors.error };
  // A diff block has no path of its own; it belongs to the path block just before it.
  let path: string | undefined;
  return (
    <box flexDirection="column">
      {props.blocks.map((block, i) => {
        if (block.kind === 'path') { path = block.path; }
        const patch = nativeDiff(block, tokens);
        if (patch !== undefined && tokens) { return <DiffBlock key={i} unified={patch} filetype={filetypeOf(path)} tokens={tokens} />; }
        return blockLines(block, colors).map((l, j) => (
          <text key={`${i}-${j}`} fg={l.fg} attributes={l.attributes} wrapMode="word">{l.text}</text>
        ));
      })}
    </box>
  );
}

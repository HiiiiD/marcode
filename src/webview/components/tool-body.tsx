import { useState } from 'react';
import {
  CheckIcon, CircleDotIcon, CircleIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useStore } from '../store';
import { clampLines, shortPath, type ToolBlock } from './tool-render';

/**
 * Renders the typed blocks produced by tool-render.ts. Every block is laid out
 * for a ~300px column: one column, no side-by-side, and anything that can be
 * long is clamped rather than allowed to bury the rest of the transcript.
 */
export function ToolBody({ blocks }: { blocks: ToolBlock[] }) {
  if (blocks.length === 0) { return null; }
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, i) => <Block key={i} block={block} />)}
    </div>
  );
}

function Block({ block }: { block: ToolBlock }) {
  switch (block.kind) {
    case 'note':
      return <p className="wrap-break-word text-muted-foreground">{block.text}</p>;

    case 'field':
      return (
        <p className="flex gap-1.5 wrap-break-word">
          <span className="shrink-0 text-muted-foreground">{block.label}</span>
          <span className="min-w-0 break-all">{block.value}</span>
        </p>
      );

    case 'command':
      return (
        <div className="flex gap-1.5 rounded bg-muted px-1.5 py-1 font-mono">
          <span aria-hidden className="shrink-0 select-none text-muted-foreground">$</span>
          <code className="min-w-0 whitespace-pre-wrap wrap-break-word">{block.text}</code>
        </div>
      );

    case 'path':
      return <PathRow path={block.path} hint={block.hint} />;

    case 'diff':
      return <ClampedLines lines={block.lines} tone="diff" />;

    case 'todos':
      return (
        <ul className="flex flex-col gap-1">
          {block.items.map((todo, i) => {
            const Icon = todo.status === 'completed' ? CheckIcon
              : todo.status === 'in_progress' ? CircleDotIcon : CircleIcon;
            return (
              <li key={i} className="flex items-start gap-1.5">
                <Icon
                  aria-hidden
                  className={cn(
                    'mt-0.5 size-3 shrink-0',
                    todo.status === 'completed' && 'text-muted-foreground',
                    todo.status === 'in_progress' && 'text-primary',
                    todo.status === 'pending' && 'text-muted-foreground/60',
                  )}
                />
                <span
                  className={cn(
                    'min-w-0 wrap-break-word',
                    todo.status === 'completed' && 'text-muted-foreground line-through',
                    todo.status === 'in_progress' && 'font-medium',
                  )}
                >
                  {todo.text}
                </span>
                <span className="sr-only">{todo.status.replace('_', ' ')}</span>
              </li>
            );
          })}
        </ul>
      );

    case 'lines':
      return <ClampedLines lines={block.text.replace(/\n+$/, '').split('\n')} tone={block.tone} />;

    case 'json':
      return (
        <pre className="max-h-64 overflow-auto rounded bg-muted px-1.5 py-1 font-mono whitespace-pre-wrap wrap-break-word">
          {block.text}
        </pre>
      );
  }
}

/**
 * A file path that reveals the file in the editor. The panel already owns a
 * `reveal-file` message and the editor is one pane away, so a path the agent
 * touched should be reachable without retyping it.
 */
function PathRow({ path, hint }: { path: string; hint?: string }) {
  const { post } = useStore();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => post({ t: 'reveal-file', path })}
      title={path}
      // Overrides the size variant's gap/padding/justification, never its
      // height — the same discipline as tool-card.tsx's disclosure row.
      className="flex w-full items-center justify-start gap-1.5 px-1.5 font-normal"
    >
      <span className="min-w-0 truncate font-mono">{shortPath(path)}</span>
      {hint && <span className="shrink-0 text-muted-foreground">{hint}</span>}
      <span className="sr-only">Open in editor</span>
    </Button>
  );
}

const TONE_CLASS = {
  output: 'bg-muted',
  code: 'bg-muted',
  error: 'bg-destructive/10 text-destructive',
  diff: 'bg-muted',
} as const;

/**
 * Head-and-tail clamp with a single reveal. A long result keeps its command
 * echo and its verdict visible; the middle collapses to a divider that says
 * how much it is hiding, and expands into a bounded scroll pane rather than
 * an unbounded run of lines.
 */
function ClampedLines({
  lines, tone,
}: {
  lines: string[];
  tone: 'output' | 'code' | 'error' | 'diff';
}) {
  const [full, setFull] = useState(false);
  const clamped = clampLines(lines.join('\n'));
  const showAll = full || clamped.hidden === 0;
  const shown = showAll ? lines : clamped.head;

  return (
    <div
      className={cn(
        'rounded px-1.5 py-1 font-mono',
        TONE_CLASS[tone],
        showAll && clamped.hidden > 0 && 'max-h-80 overflow-auto',
      )}
    >
      <Lines lines={shown} diff={tone === 'diff'} />
      {!showAll && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFull(true)}
            className="my-0.5 flex w-full items-center justify-start gap-1.5 px-0 font-normal text-muted-foreground"
          >
            <span aria-hidden className="h-px flex-1 bg-border" />
            <span>{clamped.hidden} more lines</span>
            <span aria-hidden className="h-px flex-1 bg-border" />
          </Button>
          <Lines lines={clamped.tail} diff={tone === 'diff'} />
        </>
      )}
    </div>
  );
}

function Lines({ lines, diff }: { lines: string[]; diff: boolean }) {
  return (
    <pre className="whitespace-pre-wrap wrap-break-word">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            diff && line.startsWith('+') && 'text-(--vscode-gitDecoration-addedResourceForeground)',
            diff && line.startsWith('-') && 'text-(--vscode-gitDecoration-deletedResourceForeground)',
          )}
        >
          {line === '' ? ' ' : line}
        </div>
      ))}
    </pre>
  );
}

import { useState } from 'react';
import {
  CheckIcon, CircleDotIcon, CircleIcon, CopyIcon, DownloadIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePost } from '../store';
import { clampLines, shortPath, type ToolBlock } from './tool-render';

export type Clamp = { head: number; tail: number };

/**
 * Renders the typed blocks produced by tool-render.ts. Every block is laid out
 * for a ~300px column: one column, no side-by-side, and anything that can be
 * long is clamped rather than allowed to bury the rest of the transcript.
 */
/** `fullPaths`: show each path whole (an approver must see exactly what they allow) instead of its last segments. */
export function ToolBody({ blocks, clamp, fullPaths }: { blocks: ToolBlock[]; clamp?: Clamp; fullPaths?: boolean }) {
  if (blocks.length === 0) { return null; }
  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, i) => <Block key={i} block={block} clamp={clamp} fullPaths={fullPaths} />)}
    </div>
  );
}

function Block({ block, clamp, fullPaths }: { block: ToolBlock; clamp?: Clamp; fullPaths?: boolean }) {
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
        <div className="flex gap-1.5 border-l border-border py-0.5 pr-1 pl-3 font-mono">
          <span aria-hidden className="shrink-0 select-none text-muted-foreground">$</span>
          <code className="min-w-0 whitespace-pre-wrap wrap-break-word">{block.text}</code>
        </div>
      );

    case 'path':
      return <PathRow path={block.path} hint={block.hint} full={fullPaths} />;

    case 'diff':
      return <ClampedLines lines={block.lines} tone="diff" clamp={clamp} />;

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

    case 'image':
      // `dataUri` is self-contained (already base64-embedded on the wire), so
      // this needs no webview resource root or asWebviewUri round-trip — the
      // CSP's `img-src ... data:` already covers it.
      return <ImageBlock dataUri={block.dataUri} />;
  }
}

/**
 * A tool-output image plus copy (system clipboard, for pasting elsewhere)
 * and download (via the host's save dialog) actions — same pairing and
 * placement as `CodeBlock`'s copy button in markdown.tsx, one file over.
 */
function ImageBlock({ dataUri }: { dataUri: string }) {
  const post = usePost();
  return (
    <div className="relative">
      <img
        src={dataUri}
        alt="Generated image"
        className="max-h-64 max-w-full rounded border border-border object-contain"
      />
      <div className="absolute top-1 right-1 flex gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy image"
          onClick={() => { void copyImage(dataUri); }}
          className="bg-(--vscode-editor-background)/70 text-muted-foreground"
        >
          <CopyIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Download image"
          onClick={() => post({ t: 'export-image', dataUri })}
          className="bg-(--vscode-editor-background)/70 text-muted-foreground"
        >
          <DownloadIcon />
        </Button>
      </div>
    </div>
  );
}

/**
 * `navigator.clipboard.write` wants a live `ClipboardItem`, not a
 * `data:` string. A self-`fetch` of the URI would be the usual way to get a
 * `Blob` back out, but the panel's CSP is `default-src 'none'` with no
 * `connect-src` — even a same-document `data:` fetch is a network request as
 * far as CSP is concerned, so it's refused. Decode the base64 payload by
 * hand instead; no network involved either way.
 */
async function copyImage(dataUri: string): Promise<void> {
  try {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri);
    if (!match) {
      throw new Error('not a data: URI');
    }
    const [, mime = 'application/octet-stream', isBase64, payload] = match;
    const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    toast('Image copied');
  } catch (err) {
    console.error('[mar-code] could not copy image', err);
    toast('Copy failed');
  }
}

/**
 * A file path that reveals the file in the editor. The panel already owns a
 * `reveal-file` message and the editor is one pane away, so a path the agent
 * touched should be reachable without retyping it.
 */
function PathRow({ path, hint, full }: { path: string; hint?: string; full?: boolean }) {
  const post = usePost();
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
      <span className="min-w-0 wrap-break-word text-left font-mono text-foreground/70">{full ? path : shortPath(path)}</span>
      {hint && <HintText text={hint} />}
      <span className="sr-only">Open in editor</span>
    </Button>
  );
}

// Plain output and code sit on a hairline rule, not a filled box: inside an opened row a second surface was a box in a box. Only a diff (its tint is information) and an error keep a fill.
const TONE_CLASS = {
  output: 'border-l border-border py-0.5 pr-1 pl-3',
  code: 'border-l border-border py-0.5 pr-1 pl-3',
  error: 'rounded bg-destructive/10 px-1.5 py-1 text-destructive',
  diff: 'py-0.5',
} as const;

/**
 * Head-and-tail clamp with a single reveal. A long result keeps its command
 * echo and its verdict visible; the middle collapses to a divider that says
 * how much it is hiding, and expands into a bounded scroll pane rather than
 * an unbounded run of lines.
 */
function ClampedLines({
  lines, tone, clamp,
}: {
  lines: string[];
  tone: 'output' | 'code' | 'error' | 'diff';
  clamp?: Clamp;
}) {
  const [full, setFull] = useState(false);
  const clamped = clampLines(lines.join('\n'), clamp?.head, clamp?.tail);
  const showAll = full || clamped.hidden === 0;
  const shown = showAll ? lines : clamped.head;

  return (
    <div
      className={cn(
        'font-mono',
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
            // The named tokens, which carry VS Code's always-registered chart colours as a fallback; the raw gitDecoration variables vanish on a theme or install that leaves them unset.
            diff && line.startsWith('+') && '-mx-1.5 bg-git-added/[0.07] px-1.5 text-git-added',
            diff && line.startsWith('-') && '-mx-1.5 bg-git-deleted/[0.07] px-1.5 text-git-deleted',
          )}
        >
          {line === '' ? ' ' : line}
        </div>
      ))}
    </pre>
  );
}

/** `+3 −2` in the diff's own colours; any other hint stays muted. */
function HintText({ text }: { text: string }) {
  const m = /^(\+\d+) (−\d+)$/.exec(text);
  if (!m) { return <span className="shrink-0 text-muted-foreground">{text}</span>; }
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-git-added">{m[1]}</span> <span className="text-git-deleted">{m[2]}</span>
    </span>
  );
}

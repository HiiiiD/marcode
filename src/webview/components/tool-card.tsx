import { useEffect, useState } from 'react';
import {
  BotIcon, CheckIcon, FilePenIcon, FilePlusIcon, FileTextIcon,
  FolderSearchIcon, GlobeIcon, ImageIcon, ListTodoIcon, Loader2Icon, SearchIcon,
  SendIcon, TerminalIcon, WrenchIcon, XIcon,
} from 'lucide-react';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { cn } from '@/lib/utils';
import type { TranscriptItem } from '../../protocol/messages';
import { ToolBody } from './tool-body';
import { usePost } from '../store';
import { describeInput, describeOutcome, describeOutput, describeTool, type ToolGlyph } from './tool-render';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

const GLYPHS: Record<ToolGlyph, typeof TerminalIcon> = {
  'terminal': TerminalIcon,
  'file-pen': FilePenIcon,
  'file-plus': FilePlusIcon,
  'file-text': FileTextIcon,
  'search': SearchIcon,
  'folder-search': FolderSearchIcon,
  'globe': GlobeIcon,
  'list-todo': ListTodoIcon,
  'bot': BotIcon,
  'send': SendIcon,
  'wrench': WrenchIcon,
  'image': ImageIcon,
};

export function ToolCard({
  item, more, defaultOpen = false, streaming = false, approval,
}: {
  item: ToolItem;
  /** Further calls folded into this row: identical consecutive calls read as one line with a count. */
  more?: ToolItem[];
  /** Set when this row is the record of an approval: the row is the tool's own, plus a check (allowed) or a cross (denied). */
  approval?: 'allowed' | 'denied';
  /** Starts expanded: a command the user ran themselves wants its output in view. */
  defaultOpen?: boolean;
  /** Shows text output while the call is still running (a live shell command). */
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const post = usePost();
  const tool = item.tool;
  const planPath = item.output?.kind === 'plan' ? item.output.filePath : undefined;
  useEffect(() => {
    if (item.state === 'ok' && planPath) { post({ t: 'reveal-file', path: planPath }); }
  }, [item.state, planPath, post]);
  const server = tool.kind === 'mcp' ? tool.server : undefined;
  const header = describeTool(tool);
  const all = [item, ...(more ?? [])];
  const state = all.some((i) => i.state === 'error') ? 'error' : all.some((i) => i.state === 'running') ? 'running' : item.state;
  // A settled check mark on every row is noise in a column this narrow: the
  // transcript is a log of things that already happened, so success is the
  // default reading. Only the two states that change what the user should do
  // — still running, and failed — get a visible mark. `state` still has a
  // text equivalent below, so nothing is carried by the icon alone.
  const Glyph = state === 'running' ? Loader2Icon : GLYPHS[header.glyph];
  // One glance at what the call came to, right after its target: a folded run sums its edits' size or shows the last call's output.
  const outcome = all.length > 1 && tool.kind === 'file-edit'
    ? sumEdits(all.map((call) => describeOutcome(call.tool, call.output, call.state)))
    : describeOutcome(tool, item.output, state);

  return (
    <TraceCollapsible bare open={open} onOpenChange={setOpen} className="group/item my-0">
      <div className="@container flex items-center">
        <TraceCollapsibleTrigger className="h-7 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground [&>[data-slot=trace-icon]:last-child]:opacity-40 group-hover/item:[&>[data-slot=trace-icon]:last-child]:opacity-100 focus-visible:[&>[data-slot=trace-icon]:last-child]:opacity-100 aria-expanded:[&>[data-slot=trace-icon]:last-child]:opacity-100">
          <Glyph
            aria-hidden
            className={cn(
              'shrink-0',
              state === 'running' && 'animate-spin',
              state === 'error' && 'text-destructive',
            )}
          />
          <span className="sr-only">{state}</span>
          <span className="min-w-[4.5rem] shrink-0 text-muted-foreground @md:min-w-[5rem]">{server ? 'MCP' : header.verb}</span>
          {header.primary && (
            <span
              // Consolas at 12px reads a size smaller than the 12px sans beside it (the name, the reasoning preview), so monospace targets are set at 13px to match.
              className={cn('min-w-0 truncate text-foreground/75', header.mono && 'font-mono text-xs', header.path && 'text-left [direction:rtl]')}
              title={header.full ?? (header.path ? header.primary : undefined)}
            >
              {/* A path that does not fit loses its start, not its file name: rtl moves the ellipsis to the left, the inner ltr span keeps the slashes in order. */}
              {header.path ? <span dir="ltr" className="[unicode-bidi:isolate]">{header.primary}</span> : header.primary}
            </span>
          )}
          {server && <span className="min-w-0 shrink truncate text-muted-foreground" title={server}>{server}</span>}
          {outcome && <Outcome text={outcome} />}
          {all.length > 1 && <span className="shrink-0 text-foreground/70 tabular-nums">×{all.length}</span>}
          {approval && (
            approval === 'allowed'
              ? <CheckIcon aria-label="allowed" role="img" className="ml-auto shrink-0 text-git-added" />
              : <XIcon aria-label="denied" role="img" className="ml-auto shrink-0 text-destructive" />
          )}
          {state === 'error' && (
            // The `attention` spelling used elsewhere in the panel: a word plus
            // a quiet fill, never colour alone.
            <span className="shrink-0 font-medium text-destructive">failed</span>
          )}
        </TraceCollapsibleTrigger>

      </div>

      <TraceCollapsibleContent inset className="flex flex-col gap-3">
        {all.map((call, i) => <ToolDetail key={call.id} item={call} streaming={streaming} nth={all.length > 1 ? i : undefined} />)}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** One call's input and result, as the body of an opened row. */
function ToolDetail({ item, streaming, nth }: { item: ToolItem; streaming: boolean; /** Position within a folded run; later entries drop the repeated path and say which edit they are. */ nth?: number }) {
  const header = describeTool(item.tool);
  // The row already shows the command when it has no leading cd and fits; echoing it again in the panel was a repeat.
  const blocks = describeInput(item.tool);
  const hint = (blocks.find((b) => b.kind === 'path') as { hint?: string } | undefined)?.hint;
  const input = (nth !== undefined && nth > 0
    ? [{ kind: 'note' as const, text: `${header.verb} ${nth + 1}${hint ? ` · ${hint}` : ''}` }, ...blocks.filter((b) => b.kind !== 'path')]
    : blocks).filter((b) => !(b.kind === 'command' && item.tool.kind === 'command' && b.text === header.primary));
  const output = describeOutput(
    item.tool.kind, item.output,
    streaming && item.state === 'running' && item.output?.kind === 'text' ? 'ok' : item.state,
  );
  return (
    <div className="flex flex-col gap-2">
      <ToolBody blocks={input} />
      {output.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {item.state === 'error' && <p className="font-medium text-destructive">Error</p>}
          <ToolBody blocks={output} />
        </div>
      )}
      {item.state === 'running' && <p className="text-muted-foreground">Running…</p>}
    </div>
  );
}

/** `+3 −1` and `+2 −2` folded into `+5 −3`. */
function sumEdits(parts: string[]): string {
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    const m = /^\+(\d+) −(\d+)$/.exec(part);
    if (m) { added += Number(m[1]); removed += Number(m[2]); }
  }
  return added + removed > 0 ? `+${added} −${removed}` : '';
}

/** `+12 −3` with the additions green and the removals red, like the diff it summarises; anything else stays muted. */
function Outcome({ text }: { text: string }) {
  const m = /^(\+\d+) (−\d+)$/.exec(text);
  if (!m) { return <span className="shrink-0 text-foreground/60 tabular-nums">{text}</span>; }
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-git-added">{m[1]}</span> <span className="text-git-deleted">{m[2]}</span>
    </span>
  );
}

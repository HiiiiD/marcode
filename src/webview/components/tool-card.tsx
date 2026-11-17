import { useEffect, useState } from 'react';
import {
  BotIcon, CheckIcon, FilePenIcon, FilePlusIcon, FileTextIcon,
  FolderSearchIcon, GitForkIcon, GlobeIcon, ImageIcon, ListTodoIcon, Loader2Icon, SearchIcon,
  SendIcon, TerminalIcon, WrenchIcon, XIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger,
} from '@/components/ui/trace';
import { cn } from '@/lib/utils';
import type { TranscriptItem } from '../../protocol/messages';
import { ToolBody } from './tool-body';
import { usePost } from '../store';
import { describeInput, describeOutput, describeTool, type ToolGlyph } from './tool-render';

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
  item, more, onFork, defaultOpen = false, streaming = false, approval,
}: {
  item: ToolItem; onFork?: () => void;
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

  return (
    // `group/item`, not a second `<button>` nested inside the toggle: the
    // toggle below IS a button, and a fork button placed inside it would be
    // interactive-inside-interactive — the same trap the roster row's own
    // actions trigger sits beside its checkbox item to avoid, not inside it.
    <TraceCollapsible bare open={open} onOpenChange={setOpen} className="group/item my-0">
      <div className="flex items-center">
        <TraceCollapsibleTrigger className="h-6 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground [&>[data-slot=trace-icon]:last-child]:opacity-0 group-hover/item:[&>[data-slot=trace-icon]:last-child]:opacity-100 focus-visible:[&>[data-slot=trace-icon]:last-child]:opacity-100 aria-expanded:[&>[data-slot=trace-icon]:last-child]:opacity-100">
          <Glyph
            aria-hidden
            className={cn(
              'shrink-0',
              state === 'running' && 'animate-spin',
              state === 'error' && 'text-destructive',
            )}
          />
          <span className="sr-only">{state}</span>
          {server && (
            // Muted, not colour-per-server: a palette per server would collide
            // with the status tones already in use and buys nothing when the
            // name is right beside it.
            <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
              {server}
            </span>
          )}
          <span className="shrink-0 font-medium text-foreground/80">{header.verb}</span>
          {header.primary && (
            <span
              className={cn('min-w-0 truncate text-muted-foreground', header.mono && 'font-mono')}
              title={header.full}
            >
              {header.primary}
            </span>
          )}
          {all.length > 1 && <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground tabular-nums">×{all.length}</span>}
          {approval && (
            approval === 'allowed'
              ? <CheckIcon aria-label="allowed" role="img" className="ml-auto shrink-0 text-git-added" />
              : <XIcon aria-label="denied" role="img" className="ml-auto shrink-0 text-destructive" />
          )}
          {state === 'error' && (
            // The `attention` spelling used elsewhere in the panel: a word plus
            // a quiet fill, never colour alone.
            <span className="ml-auto shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 font-medium text-destructive">
              failed
            </span>
          )}
        </TraceCollapsibleTrigger>

        {onFork && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Fork from here"
            title="Fork a new session from this point"
            onClick={onFork}
            className="mr-1 shrink-0 text-muted-foreground opacity-0 group-hover/item:opacity-100 focus:opacity-100"
          >
            <GitForkIcon />
          </Button>
        )}
      </div>

      <TraceCollapsibleContent inset className="flex flex-col gap-3">
        {all.map((call) => <ToolDetail key={call.id} item={call} streaming={streaming} />)}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** One call's input and result, as the body of an opened row. */
function ToolDetail({ item, streaming }: { item: ToolItem; streaming: boolean }) {
  const input = describeInput(item.tool);
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

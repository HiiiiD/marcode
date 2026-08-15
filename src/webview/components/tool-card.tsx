import { useState } from 'react';
import {
  BotIcon, ChevronDownIcon, ChevronRightIcon, FilePenIcon, FilePlusIcon, FileTextIcon,
  FolderSearchIcon, GlobeIcon, ListTodoIcon, Loader2Icon, SearchIcon, SendIcon,
  TerminalIcon, WrenchIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TranscriptItem } from '../../protocol/messages';
import { ToolBody } from './tool-body';
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
};

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const tool = item.tool;
  const server = tool.kind === 'mcp' ? tool.server : undefined;
  const header = describeTool(tool);
  // A settled check mark on every row is noise in a column this narrow: the
  // transcript is a log of things that already happened, so success is the
  // default reading. Only the two states that change what the user should do
  // — still running, and failed — get a visible mark. `state` still has a
  // text equivalent below, so nothing is carried by the icon alone.
  const Glyph = item.state === 'running' ? Loader2Icon : GLYPHS[header.glyph];
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  const input = describeInput(tool);
  const output = describeOutput(tool.kind, item.output, item.state);

  return (
    <div className="my-0 rounded border border-border text-xs">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`tool-${item.toolId}`}
        // `gap-2`/`px-2`/`justify-start` override `size="sm"`'s own gap/px —
        // the fixed h-7 the variant sets is kept, not hand-written, per the
        // Task 2 discipline against overriding a size variant's height.
        className="flex w-full items-center justify-start gap-2 px-2 font-normal"
      >
        <Glyph
          aria-hidden
          className={cn(
            'shrink-0',
            item.state === 'running' && 'animate-spin',
            item.state === 'error' && 'text-destructive',
          )}
        />
        <span className="sr-only">{item.state}</span>
        {server && (
          // Muted, not colour-per-server: a palette per server would collide
          // with the status tones already in use and buys nothing when the
          // name is right beside it.
          <span className="shrink-0 rounded bg-muted px-1 text-muted-foreground">
            {server}
          </span>
        )}
        <span className="shrink-0 font-medium">{header.verb}</span>
        {header.primary && (
          <span
            className={cn('min-w-0 truncate text-muted-foreground', header.mono && 'font-mono')}
            title={header.full}
          >
            {header.primary}
          </span>
        )}
        {item.state === 'error' && (
          // The `attention` spelling used elsewhere in the panel: a word plus
          // a quiet fill, never colour alone.
          <span className="ml-auto shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 font-medium text-destructive">
            failed
          </span>
        )}
        <Chevron aria-hidden className={cn('shrink-0 text-muted-foreground', item.state !== 'error' && 'ml-auto')} />
      </Button>

      {open && (
        <div id={`tool-${item.toolId}`} className="flex flex-col gap-1.5 border-t border-border px-2 py-1.5">
          <ToolBody blocks={input} />
          {output.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-muted-foreground">
                {item.state === 'error' ? 'Error' : 'Result'}
              </p>
              <ToolBody blocks={output} />
            </div>
          )}
          {item.state === 'running' && (
            <p className="text-muted-foreground">Running…</p>
          )}
        </div>
      )}
    </div>
  );
}

import { ArrowDownUpIcon, CheckIcon, SearchIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import type { HistoryQuery, SortDir, SortKey } from './history-rows';

interface Props {
  query: HistoryQuery;
  attentionCount: number;
  onChange: (next: HistoryQuery) => void;
}

const SORT_LABEL: Record<SortKey, string> = { updatedAt: 'Updated', createdAt: 'Created' };

export function HistoryToolbar({ query, attentionCount, onChange }: Props) {
  const active = query.needsAttention === true;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <InputGroup className="h-8 min-w-40 flex-1 basis-48">
        <InputGroupAddon align="inline-start" className="pl-2.5 text-muted-foreground">
          <SearchIcon aria-hidden className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Filter sessions"
          placeholder="Filter sessions"
          value={query.text}
          onChange={(e) => onChange({ ...query, text: e.target.value })}
          className="text-xs md:text-xs"
        />
        {query.text !== '' && (
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear filter"
              onClick={() => onChange({ ...query, text: '' })}
            >
              <XIcon aria-hidden />
            </Button>
          </InputGroupAddon>
        )}
      </InputGroup>
      <Button
        variant="outline"
        size="sm"
        aria-pressed={active}
        className={cn('h-8', active && 'border-attention/60 bg-attention/15 text-foreground hover:bg-attention/20')}
        onClick={() => onChange({ ...query, needsAttention: !active })}
      >
        {active && <CheckIcon aria-hidden />}
        Needs attention
        {attentionCount > 0 && (
          <span className="rounded-full bg-attention/20 px-1.5 text-[11px] tabular-nums text-attention">
            {attentionCount}
          </span>
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="h-8" aria-label="Sort sessions" title={`Sort: ${SORT_LABEL[query.sort]}, ${query.dir === 'asc' ? 'oldest' : 'newest'} first`} />}
        >
          <ArrowDownUpIcon aria-hidden />
          <span className="hidden sm:inline">{`${SORT_LABEL[query.sort]} ${query.dir === 'asc' ? '↑' : '↓'}`}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={query.sort}
            onValueChange={(v) => onChange({ ...query, sort: v as SortKey })}
          >
            <DropdownMenuRadioItem value="updatedAt">Last updated</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="createdAt">Created</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={query.dir}
            onValueChange={(v) => onChange({ ...query, dir: v as SortDir })}
          >
            <DropdownMenuRadioItem value="desc">Newest first</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="asc">Oldest first</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

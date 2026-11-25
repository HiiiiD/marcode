import { CheckIcon, SearchIcon, XIcon } from 'lucide-react';
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
      <InputGroup className="h-8 min-w-28 flex-1 basis-40">
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
        aria-label="Needs attention"
        className={cn('h-8 text-xs', active && 'border-attention/70 bg-attention/25 text-foreground hover:bg-attention/30 dark:border-attention/70 dark:bg-attention/25 dark:hover:bg-attention/30')}
        onClick={() => onChange({ ...query, needsAttention: !active })}
      >
        {active && <CheckIcon aria-hidden />}
        <span className="hidden min-[480px]:inline">Needs attention</span>
        <span className="min-[480px]:hidden">Attention</span>
        {attentionCount > 0 && (
          <span className="rounded-full bg-attention/20 px-1.5 text-[11px] tabular-nums text-attention">
            {attentionCount}
          </span>
        )}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="sm" className="h-8 text-xs" aria-label="Sort sessions" title={`Sort: ${SORT_LABEL[query.sort]}, ${query.dir === 'asc' ? 'oldest' : 'newest'} first`} />}
        >
          {`${SORT_LABEL[query.sort]} ${query.dir === 'asc' ? '↑' : '↓'}`}
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

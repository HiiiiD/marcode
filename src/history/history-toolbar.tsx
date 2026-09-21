import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsIndicator, TabsList, TabsTab } from '@/components/ui/tabs';
import type { HistoryQuery, SortKey, StatusFilter } from './history-rows';

interface Props {
  query: HistoryQuery;
  onChange: (next: HistoryQuery) => void;
}

export function HistoryToolbar({ query, onChange }: Props) {
  const ascending = query.dir === 'asc';
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Input
        aria-label="Filter sessions"
        placeholder="Filter by title, model or summary"
        value={query.text}
        onChange={(e) => onChange({ ...query, text: e.target.value })}
        className="h-7 max-w-sm min-w-48 flex-1 text-xs md:text-xs"
      />
      <Tabs
        value={query.status}
        onValueChange={(v) => onChange({ ...query, status: v as StatusFilter })}
      >
        <TabsList aria-label="Show">
          <TabsTab value="all">All</TabsTab>
          <TabsTab value="active">Active</TabsTab>
          <TabsTab value="archived">Archived</TabsTab>
          <TabsIndicator />
        </TabsList>
      </Tabs>
      <div className="ml-auto flex items-center gap-1">
        <Tabs
          value={query.sort}
          onValueChange={(v) => onChange({ ...query, sort: v as SortKey })}
        >
          <TabsList aria-label="Sort by">
            <TabsTab value="updatedAt">Updated</TabsTab>
            <TabsTab value="createdAt">Created</TabsTab>
            <TabsIndicator />
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={ascending ? 'Sort descending' : 'Sort ascending'}
          onClick={() => onChange({ ...query, dir: ascending ? 'desc' : 'asc' })}
        >
          {ascending ? <ArrowUpIcon aria-hidden /> : <ArrowDownIcon aria-hidden />}
        </Button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStore } from '../store';

const ACTION_LABEL: Record<'migrate' | 'add-stub', string> = {
  migrate: 'Migrate',
  'add-stub': 'Add stub',
};

/**
 * AGENTS.md is the source of truth; CLAUDE.md, when present, is only ever a
 * `@AGENTS.md` stub. This card lists the dirs where that has drifted — real
 * content in CLAUDE.md with no sibling AGENTS.md ("migrate"), or an
 * AGENTS.md the Claude provider can't see because there's no CLAUDE.md stub
 * ("add-stub") — sent once per activate/reload (see `agents-md-nudge.ts`;
 * there is no live watcher, so a file added mid-session surfaces on the next
 * reload).
 *
 * Renders nothing once `state.agentsMdNudgeHits` is empty — every row
 * resolved or dismissed — which is also what makes the card disappear right
 * after the last row's action round-trips.
 */
export function AgentsMdNudgeCard() {
  const { state, post } = useStore();
  const hits = state.agentsMdNudgeHits;
  // Local, not derived from `hits`: a click must disable its own row
  // immediately, and the host's reply (which removes the row, or leaves it
  // with an error) can take a message round-trip to arrive. Cleared per dir
  // once its row is gone from `hits` — see the effect-free reconciliation
  // below, matching PermissionCard/RelocationCard's `answered` pattern.
  const [pendingDirs, setPendingDirs] = useState<Set<string>>(new Set());

  if (hits.length === 0) { return null; }

  const dispatch = (action: 'migrate' | 'dismiss', dirs: string[]) => {
    setPendingDirs((prev) => new Set([...prev, ...dirs]));
    post({ t: 'agents-md-nudge-action', action, dirs });
  };

  return (
    <div className="mx-2 mt-2 rounded border-2 border-border bg-muted/40 p-2 text-xs">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {hits.length} file{hits.length === 1 ? '' : 's'} could use AGENTS.md
        </span>
        <div className="flex items-baseline gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 px-1 py-0 text-xs"
            onClick={() => dispatch('migrate', hits.map((h) => h.dir))}
          >
            Migrate all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto shrink-0 px-1 py-0 text-xs"
            aria-label="Dismiss all"
            onClick={() => dispatch('dismiss', hits.map((h) => h.dir))}
          >
            ✕
          </Button>
        </div>
      </div>
      <ul className="space-y-1">
        {hits.map((hit) => {
          const busy = pendingDirs.has(hit.dir);
          return (
            <li key={hit.dir} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={hit.dir}>
                {hit.dir === '.' ? '/' : hit.dir}
                {hit.error ? <span className="ml-2 text-destructive">{hit.error}</span> : null}
              </span>
              <div className="flex shrink-0 items-baseline gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto px-1 py-0 text-xs"
                  disabled={busy}
                  onClick={() => dispatch('migrate', [hit.dir])}
                >
                  {ACTION_LABEL[hit.kind]}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto px-1 py-0 text-xs"
                  disabled={busy}
                  aria-label={`Dismiss ${hit.dir}`}
                  onClick={() => dispatch('dismiss', [hit.dir])}
                >
                  ✕
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Ring } from './ring';
import { useStore } from '../store';
import type { UsageWindow } from '../../protocol/messages';

function resetsIn(at: number | undefined, now: number): string | undefined {
  if (at === undefined) { return undefined; }
  const ms = at - now;
  if (ms <= 0) { return undefined; }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) { return `resets in ${minutes}m`; }
  const hours = Math.round(minutes / 60);
  if (hours < 48) { return `resets in ${hours}h`; }
  return `resets in ${Math.round(hours / 24)}d`;
}

function WindowChip({ window: w }: { window: UsageWindow }) {
  const label = `${w.label} ${w.usedPercent}% used`;
  const reset = resetsIn(w.resetsAt, Date.now());
  return (
    <Tooltip>
      {/*
        A bare span would make this tooltip mouse-only; the reset time lives
        nowhere else, so the chip has to be reachable by keyboard. It is not
        a control — nothing happens on activation — so it is a focusable
        `img` role rather than a button.
      */}
      <TooltipTrigger
        render={(
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            className="inline-flex items-center gap-1 rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        )}
      >
        <Ring percent={w.usedPercent} size={12} />
        <span className="text-muted-foreground">{w.label}</span>
        <span className="tabular-nums">{w.usedPercent}%</span>
      </TooltipTrigger>
      <TooltipContent>{reset ? `${label} · ${reset}` : label}</TooltipContent>
    </Tooltip>
  );
}

function ProviderUsage({
  displayName, windows, showName,
}: { displayName: string; windows: UsageWindow[] | undefined; showName: boolean }) {
  // One quiet state covers two situations the push cannot tell apart: an
  // account that has not reported yet, and a session that never will (an API
  // key, Bedrock or Vertex, where plan limits do not exist). Asserting either
  // one would be a claim we cannot support, so the copy says only what is
  // true of both.
  if (!windows || windows.length === 0) {
    return <span className="text-muted-foreground">Plan usage not reported</span>;
  }

  return (
    <span className="flex shrink-0 items-center gap-3">
      {showName && <span className="text-muted-foreground">{displayName}</span>}
      {windows.map((w) => <WindowChip key={w.id} window={w} />)}
    </span>
  );
}

export function UsageStrip() {
  const { state } = useStore();
  // Providers that actually have sessions — the catalog can list one the
  // user has never opened, and the strip is about this panel's accounts.
  const providerIds = [...new Set(state.sessions.map((s) => s.providerId))];

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-x-auto overflow-y-hidden border-t border-border px-2 text-xs">
      {providerIds.map((id) => (
        <ProviderUsage
          key={id}
          displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
          windows={state.usageByProvider[id]}
          showName={providerIds.length > 1}
        />
      ))}
    </div>
  );
}

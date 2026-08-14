import { useEffect, useRef } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Ring } from './ring';
import { useStore } from '../store';
import type { UsageResult, UsageWindow } from '../../protocol/messages';

const REFRESH_MS = 5000;

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
  displayName, result, showName,
}: { displayName: string; result: UsageResult | undefined; showName: boolean }) {
  // Nothing back yet: the row still occupies its height, so the panel does
  // not jolt when the first reply lands.
  if (!result) { return null; }

  if (!result.ok) {
    return <span className="truncate text-muted-foreground">{result.reason}</span>;
  }

  // An empty window list is a plan-less session (API key, Bedrock, Vertex),
  // which is a normal configuration and must not read like a failure.
  if (result.windows.length === 0) {
    return <span className="text-muted-foreground">No plan limits</span>;
  }

  return (
    <span className="flex items-center gap-3">
      {showName && <span className="text-muted-foreground">{displayName}</span>}
      {result.windows.map((w) => <WindowChip key={w.id} window={w} />)}
    </span>
  );
}

export function UsageStrip() {
  const { state, post } = useStore();
  // Providers that actually have sessions — the catalog can list a provider
  // the user has never opened, and asking about it would always be not-ok.
  const providerIds = [...new Set(state.sessions.map((s) => s.providerId))];
  const providerKey = providerIds.join(',');
  // Status flips to 'idle' at turn-end, which is exactly when plan usage has
  // moved; keying the effect on it is what "refresh after any session's
  // turn-end" means on the client side.
  const statusKey = state.sessions.map((s) => `${s.id}:${s.status}`).join(',');
  const lastRequestedRef = useRef<Record<string, number>>({});

  useEffect(() => {
    const now = Date.now();
    for (const id of providerIds) {
      if (now - (lastRequestedRef.current[id] ?? 0) < REFRESH_MS) { continue; }
      lastRequestedRef.current[id] = now;
      post({ t: 'request-usage', providerId: id });
    }
  }, [providerKey, statusKey]);

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-hidden border-t border-border px-2 text-xs">
      {providerIds.map((id) => (
        <ProviderUsage
          key={id}
          displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
          result={state.usageByProvider[id]}
          showName={providerIds.length > 1}
        />
      ))}
    </div>
  );
}

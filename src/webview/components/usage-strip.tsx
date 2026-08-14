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
  // The host prunes expired windows on read, but the client holds its own
  // copy until the next broadcast — and broadcasts ride on provider events,
  // which may be hours apart. So a window can pass its reset with nothing
  // arriving to correct it, and the same `resetsAt > now` filter has to run
  // here or the chip keeps showing a percentage the host itself considers
  // wrong. Evaluated per render rather than on a timer: every render already
  // reads the clock for `resetsIn`, and a second clock is a second thing to
  // keep correct.
  const now = Date.now();
  const live = windows?.filter((w) => w.resetsAt === undefined || w.resetsAt > now);

  // One quiet state covers three situations the push cannot tell apart: an
  // account that has not reported yet, a session that never will (an API key,
  // Bedrock or Vertex, where plan limits do not exist), and one whose windows
  // have all expired unrefreshed. Asserting any one of them would be a claim
  // we cannot support, so the copy says only what is true of all three.
  //
  // showName applies here too, not just in the chip branch below: with
  // several providers in the roster, an unlabelled "Plan usage not reported"
  // is ambiguous about which account it describes, and two of them side by
  // side are indistinguishable.
  if (!live || live.length === 0) {
    return (
      <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
        {showName && <span>{displayName}</span>}
        <span>Plan usage not reported</span>
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-3">
      {showName && <span className="text-muted-foreground">{displayName}</span>}
      {live.map((w) => <WindowChip key={w.id} window={w} />)}
    </span>
  );
}

export function UsageStrip() {
  const { state } = useStore();
  // Providers that have actually reported, NOT providers that have sessions.
  // Usage belongs to the account: a second subscription is worth showing with
  // no session open for it, and a provider on an API key can never report at
  // all — a row for that one would be permanent noise no user action clears.
  const now = Date.now();
  const reporting = Object.entries(state.usageByProvider)
    .filter(([, windows]) => windows?.some((w) => w.resetsAt === undefined || w.resetsAt > now))
    .map(([id]) => id);

  // Unmounted, not empty: an empty bordered bar is permanent chrome for a
  // state that never has content. The panel's bottom edge shifts when the
  // first pull lands, which is the right trade in a 300-500px sidebar.
  if (reporting.length === 0) { return null; }

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 overflow-x-auto overflow-y-hidden border-t border-border px-2 text-xs">
      {reporting.map((id) => (
        <ProviderUsage
          key={id}
          displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
          windows={state.usageByProvider[id]}
          showName={reporting.length > 1}
        />
      ))}
    </div>
  );
}

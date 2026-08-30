import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Ring } from './ring';
import { useStore } from '../store';
import type { UsageWindow } from '../../protocol/messages';

function resetsIn(at: number | undefined, now: number): string | undefined {
  if (at === undefined) { return undefined; }
  if (at - now <= 0) { return undefined; }
  const resetDate = new Date(at);
  const nowDate = new Date(now);
  const sameDay = resetDate.getFullYear() === nowDate.getFullYear()
    && resetDate.getMonth() === nowDate.getMonth()
    && resetDate.getDate() === nowDate.getDate();
  const time = resetDate.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) { return `resets at ${time}`; }
  const date = resetDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `resets ${date} at ${time}`;
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
  displayName, windows,
}: { displayName: string; windows: UsageWindow[] | undefined }) {
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
  // The name is always shown, not gated on how many providers currently
  // report: a provider can drop out of `reporting` mid-session (an auth
  // failure, an expired token), leaving a single row that would otherwise be
  // indistinguishable from any other provider's row.
  if (!live || live.length === 0) {
    return (
      <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
        <span className="shrink-0">{displayName}</span>
        <span>Plan usage not reported</span>
      </div>
    );
  }

  // Wraps rather than scrolls. A horizontal scrollbar inside a 24px bar eats
  // half its height and hides the overflow behind a gesture nobody makes at
  // this size — the account whose numbers scrolled off is exactly the one the
  // strip exists to surface. Wrapping costs a row and hides nothing.
  return (
    <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-0.5">
      <span className="shrink-0 text-muted-foreground">{displayName}</span>
      {live.map((w) => <WindowChip key={w.id} window={w} />)}
    </div>
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

  // One row per provider, stacked — not one line that scrolls. Plan limits
  // belong to accounts, and two accounts side by side in a 300px column is
  // the case that overflows, not the exception. Height grows only when a
  // second provider actually reports.
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-border px-2 py-1 text-xs">
      {reporting.map((id) => (
        <ProviderUsage
          key={id}
          displayName={state.catalog.find((p) => p.id === id)?.displayName ?? id}
          windows={state.usageByProvider[id]}
        />
      ))}
    </div>
  );
}

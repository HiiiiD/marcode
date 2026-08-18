import { useCallback, useEffect, useRef, useState } from 'react';
import { FILE_CAP, MAX_FILE_CAP } from '../shared/file-cap';
import type { WebviewToHost } from '../protocol/messages';

/**
 * Every `request-fleet-diff` the review tab ever sends, and the one piece of
 * state (`cap`) all of them have to agree about.
 *
 * Three call sites want to post this message — the initial mount, the
 * debounced re-read that follows a session going idle, and "Show more" — plus
 * a fourth, Refresh, that a caller can build on `refresh()`. Before this
 * extraction each one carried its own opinion of `cap` and only agreed by
 * inspection; a fourth call site (Refresh) disagreed outright by omitting it,
 * silently collapsing a list the user had just raised. Bundling the state and
 * every effect that posts off it into one hook makes that agreement
 * structural: there is exactly one `cap`, and the only way to change it is
 * `showMore`.
 */
export interface FleetDiffRequests {
  /** Undefined means "the default" — the host's own `FILE_CAP` — and is
   * never sent as a literal, so a fresh mount asks for the default rather
   * than pinning a number the surface never chose. */
  cap: number | undefined;
  /** Doubles the cap (clamped to `MAX_FILE_CAP`) and re-requests with it. */
  showMore: () => void;
  /** Re-requests at the current cap — Refresh, routed through here so it
   * cannot drop it the way the raw post it replaced did. */
  refresh: () => void;
  /** Past this, doubling forever would leave "Show more" on screen as a
   * permanent no-op: the host keeps clamping to `MAX_FILE_CAP` regardless. */
  atCeiling: boolean;
}

/**
 * The next cap `showMore` asks for: double the current effective cap,
 * clamped to the ceiling. Pure, and separated from the hook so the doubling
 * rule is unit-testable without a DOM — the same reason `nextIndex` is split
 * out of `useRovingRows`.
 */
export function nextCap(current: number | undefined): number {
  return Math.min((current ?? FILE_CAP) * 2, MAX_FILE_CAP);
}

/**
 * `visible` and `dirty` mirror `ReviewState.visible`/`fleetDiffDirty` — passed
 * in rather than read from `useStore` so this hook stays about the request
 * contract, not about where its inputs come from.
 */
export function useFleetDiffRequests(
  post: (msg: WebviewToHost) => void,
  visible: boolean,
  dirty: number,
  /** `ReviewState.pollIntervalMs` — `marcode.review.pollIntervalMs`, as
   * last reported by `hydrate`. Passed in for the same reason `visible`
   * and `dirty` are: this hook stays about the request contract, not about
   * where its inputs come from. */
  pollIntervalMs: number,
): FleetDiffRequests {
  const [cap, setCap] = useState<number | undefined>(undefined);
  // The debounce effect below reads the cap through this ref rather than as a
  // dependency: `showMore` posts its own request immediately, and if the
  // effect also depended on `cap` it would re-arm on that same change and,
  // for a still-dirty tree, fire a second, redundant read 750ms later. The
  // ref keeps the debounced request current without making `cap` a trigger.
  const capRef = useRef(cap);
  capRef.current = cap;

  // Ask once on mount: the surface is the only thing that wants this, so it
  // is the only thing that asks for it.
  useEffect(() => { post({ t: 'request-fleet-diff' }); }, [post]);

  // And again, debounced, whenever the reducer counted something that could
  // have changed a diff. `pollIntervalMs` (750 by default, `marcode.review
  // .pollIntervalMs` otherwise) coalesces a burst of edits inside one turn
  // into a single request; without it a fan-out of file writes would put one
  // git invocation per tree on the host for every edit.
  //
  // Gated on `visible`: a tab in a background editor group would otherwise
  // keep this timer running forever — one git invocation per working tree, on
  // this cadence, for a surface nobody can see. A background tab shows
  // stale rows for one request cycle when it comes back into view; that trade
  // is deliberately cheaper than the alternative. `dirty` keeps counting
  // while hidden, so becoming visible again with a non-zero count re-enters
  // this effect (because `visible` is a dependency) and reads once — no
  // separate edge-detection effect needed.
  useEffect(() => {
    if (!visible || dirty === 0) { return; }
    const timer = setTimeout(() => {
      post({ t: 'request-fleet-diff', cap: capRef.current });
    }, pollIntervalMs);
    return () => { clearTimeout(timer); };
  }, [visible, dirty, post, pollIntervalMs]);

  const atCeiling = cap !== undefined && cap >= MAX_FILE_CAP;

  const showMore = useCallback(() => {
    // Doubling from the current effective cap, not jumping to the ceiling: a
    // user with 340 more files wants to see them, not to make the host parse
    // 2000 numstat rows on the way there. Clamped to the ceiling so a press
    // past it cannot grow `cap` unboundedly while the host's answer stays
    // fixed at `MAX_FILE_CAP`.
    const next = nextCap(capRef.current);
    setCap(next);
    post({ t: 'request-fleet-diff', cap: next });
  }, [post]);

  const refresh = useCallback(() => {
    post({ t: 'request-fleet-diff', cap: capRef.current });
  }, [post]);

  return { cap, showMore, refresh, atCeiling };
}

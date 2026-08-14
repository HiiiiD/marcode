import type { ClientState } from "../reducer";

/**
 * Why a session's provider cannot be used right now, or `undefined` when it
 * can.
 *
 * The catalog is the authority: the host only puts a provider there once its
 * backend has answered, so a session whose provider is missing from it cannot
 * be run — the host would refuse the send. The `unavailable` list supplies the
 * explanation when there is one.
 *
 * The two cases without an entry are deliberately worded differently. "Not
 * probed yet" is the ordinary state for the first second of a panel's life,
 * and telling a user their install is broken while we are still asking would
 * be wrong; telling them nothing at all, with a dead composer, would be worse.
 */
export function unavailabilityFor(state: ClientState, providerId: string): string | undefined {
  if (state.catalog.some((p) => p.id === providerId)) {
    return undefined;
  }
  return state.unavailable.find((p) => p.id === providerId)?.reason
    ?? "Checking whether this provider is available…";
}

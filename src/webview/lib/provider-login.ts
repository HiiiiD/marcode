/**
 * Whether a provider's reason string names an auth failure a login terminal
 * could fix, as opposed to a dead binary or anything else re-signing in
 * would not touch.
 *
 * The caller always already knows *which* provider — an unavailable-list
 * entry carries `id`, a transcript item's session carries `providerId` — so
 * this only answers "does a login action belong here", never "which
 * provider does this text name". Matched on the exact phrasing the two
 * providers already normalize their OAuth-expiry / signed-out errors to
 * (`claude-provider.ts`'s `authFailureReason`, `codex-provider.ts`'s
 * `fetchModels`), client-side so the action can be offered wherever that
 * string surfaces without a new boolean traveling the wire for it.
 */
export function isSignInFailure(reason: string | undefined): boolean {
  return reason !== undefined && /Not signed in to \w+\b/i.test(reason);
}

/**
 * Whether the Login action belongs on this failure.
 *
 * `loginKind` is a GATE, never a FORCER: `'none'` suppresses the button
 * regardless of the message text (an API-key claude instance's failure is
 * never fixed by a terminal login), and every other value — `'oauth'` or
 * `undefined` — falls through to the message-text heuristic. Both providers
 * already normalize genuine sign-in failures to text `isSignInFailure`
 * matches, so an oauth-kind instance still gets the button for those; it is
 * just no longer forced on for an unrelated failure (a tool error, a
 * dropped connection) that a login flow would not fix.
 */
export function shouldOfferLogin(reason: string | undefined, loginKind: 'oauth' | 'none' | undefined): boolean {
  if (loginKind === 'none') { return false; }
  return isSignInFailure(reason);
}

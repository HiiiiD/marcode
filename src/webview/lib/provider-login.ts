/**
 * Which provider a "not signed in" reason names, or `undefined` when the
 * reason is not an auth failure at all — a dead CLI, a missing binary, or
 * anything else, none of which a terminal-based login fixes.
 *
 * Matched on the exact phrasing the two providers already normalize their
 * OAuth-expiry / signed-out errors to (`claude-provider.ts`'s
 * `authFailureReason`, `codex-provider.ts`'s `fetchModels`) — client-side,
 * so a login action can be offered wherever that string surfaces
 * (`UnavailableProvider.reason`, a session error transcript item) without a
 * new boolean traveling the wire for it.
 */
export function loginProviderFor(reason: string | undefined): string | undefined {
  if (reason === undefined) { return undefined; }
  if (/Not signed in to Claude\b/i.test(reason)) { return 'claude'; }
  if (/Not signed in to Codex\b/i.test(reason)) { return 'codex'; }
  return undefined;
}

// "Not logged in" is what a config dir with no credentials yet (a fresh provider instance) reports.
const SDK_AUTH_FAILURE = /Failed to authenticate|OAuth session expired|Not logged in|Please run \/login/i;

export const CLAUDE_SIGN_IN_MESSAGE = 'Not signed in to Claude. Run `claude auth login`.';

/**
 * The SDK's own OAuth-expiry text, turned into the same "not signed in"
 * phrasing Codex's `fetchModels` already uses — so the panel's reauth
 * action (matched client-side on that phrasing) recognizes both providers
 * with one pattern. `undefined` when `raw` is not an auth failure, so
 * callers fall back to the message unchanged.
 */
export function authFailureReason(raw: string): string | undefined {
  return SDK_AUTH_FAILURE.test(raw) ? CLAUDE_SIGN_IN_MESSAGE : undefined;
}

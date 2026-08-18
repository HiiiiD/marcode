/**
 * Setting ids both bundles need to agree on.
 *
 * The webview cannot read configuration — it asks the host to reveal a
 * section by name — and the host reads the same section to decide which
 * providers to register. Two spellings of one id is one typo away from a
 * button that opens an empty settings search, so the id lives here, in the
 * only other module (besides the protocol) both bundles import.
 */

/** Which providers this install registers. See `package.json`'s contribution. */
export const ENABLED_PROVIDERS_SETTING = 'hiiiidCode.enabledProviders';

/** The provider ids that setting accepts, and the ones enabled by default. */
export const KNOWN_PROVIDER_IDS = ['claude', 'codex', 'opencode', 'fake'] as const;

/**
 * `fake` is deliberately absent: it is a scripted stand-in for tests and the
 * dev host, and a shipped panel offering it would be offering a backend that
 * answers "ok" to everything. It stays a legal value anyone can add.
 */
export const DEFAULT_PROVIDER_IDS: string[] = ['claude', 'codex', 'opencode'];

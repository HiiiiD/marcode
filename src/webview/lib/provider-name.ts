import type { ClientState } from '../../client-core/reducer';

const KNOWN: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', fake: 'Fake' };

/**
 * The one spelling of a provider's name, wherever the panel shows it: the catalog's own
 * display name first, then the one a usage report carried, then a canonical name for the
 * built-in backends (an instance id such as `opencode-openai` resolves by its first segment).
 */
export function providerName(state: Pick<ClientState, 'catalog' | 'usageDisplayNames'>, id: string | undefined): string {
  if (id === undefined) { return ''; }
  const named = state.catalog.find((p) => p.id === id)?.displayName ?? state.usageDisplayNames[id];
  if (named) { return named; }
  const first = id.split('-')[0] ?? id;
  return KNOWN[first] ?? first.charAt(0).toUpperCase() + first.slice(1);
}

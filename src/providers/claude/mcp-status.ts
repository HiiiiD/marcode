import { redactSecrets } from '../redact';
import type { McpOrigin, McpServerStatus } from '../types';

/** The fields of the SDK's `McpServerStatus` this mapping reads. `config` is deliberately never read. */
export interface SdkMcpStatusLike {
  name: string;
  status: string;
  error?: string;
  source?: string;
  scope?: string;
  tools?: unknown[];
  config?: unknown;
}

const STATES = new Set<McpServerStatus['state']>(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);
const ORIGIN: Record<string, McpOrigin> = { project: 'repo', user: 'global', local: 'repo-private' };

/** Trust is keyed on `source` (the SDK says so), falling back to `scope` on CLIs that predate it. */
export function toMcpStatuses(raw: SdkMcpStatusLike[]): McpServerStatus[] {
  return raw
    .filter((s) => (s.source ?? s.scope) !== 'claudeai' && s.name !== 'marcode_self_control')
    .map((s) => {
      const state = STATES.has(s.status as McpServerStatus['state']) ? s.status as McpServerStatus['state'] : 'pending';
      const source = s.source ?? s.scope;
      const origin = source === undefined ? undefined : (ORIGIN[source] ?? 'other');
      return {
        name: s.name,
        state,
        ...(s.tools ? { toolCount: s.tools.length } : {}),
        ...(s.error ? { error: redactSecrets(s.error) } : {}),
        ...(origin ? { origin } : {}),
        ...(origin === 'other' ? { originLabel: source } : {}),
        ...(origin ? { canSignIn: false } : {}),
      };
    });
}

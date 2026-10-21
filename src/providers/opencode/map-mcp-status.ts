import type { McpOrigin, McpServerStatus } from '../types';

export type OpenCodeMcpStatus = Record<string, { status?: string; error?: string }>;

const STATES: Record<string, McpServerStatus['state']> = {
  connected: 'connected', disabled: 'disabled', failed: 'failed',
  needs_auth: 'needs-auth', needs_client_registration: 'needs-auth',
};

/** `GET /mcp` → statuses; `origins` comes from reading the config files, which the endpoint doesn't report. */
export function toOpenCodeStatuses(raw: OpenCodeMcpStatus, origins: Map<string, McpOrigin>): McpServerStatus[] {
  return Object.entries(raw)
    .filter(([name]) => name !== 'marcode_self_control')
    .map(([name, s]) => {
      const state = STATES[s.status ?? ''] ?? 'pending';
      const origin = origins.get(name);
      return {
        name,
        state,
        ...(s.error && state === 'failed' ? { error: s.error } : {}),
        ...(origin ? { origin } : {}),
        canSignIn: state === 'needs-auth',
      };
    });
}

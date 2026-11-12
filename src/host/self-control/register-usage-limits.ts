import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDeps } from './tool-deps';

export function registerUsageLimitsTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  mcp.registerTool(
    'marcode__get_usage_limits',
    {
      title: 'Plan usage limits per provider',
      description: 'Marcode-specific: returns the account\'s plan usage windows (e.g. the 5-hour and weekly '
        + 'limits) per provider, each as `usedPercent` (0-100) and `resetsAt` (ISO time) when known. Call it '
        + 'before starting or spawning heavy work to see how much headroom is left. Refreshed on call, '
        + 'falling back to the last known figures if the refresh fails. A provider with no entry reports no usage. Optional `provider` restricts to one provider.',
      inputSchema: z.object({
        provider: z.string().optional().describe('A provider id, as in marcode__list_models.'),
      }),
    },
    async ({ provider }) => {
      if (!sessionManager.usageSnapshot) { return { isError: true, content: [{ type: 'text' as const, text: 'Usage is not available in this window.' }] }; }
      await sessionManager.refreshUsage?.(caller()?.cwd ?? '');
      const names = sessionManager.usageDisplayNames?.() ?? {};
      const snapshot = Object.entries(sessionManager.usageSnapshot())
        .filter(([id]) => provider === undefined || id === provider)
        .map(([id, windows]) => ({
          provider: id,
          ...(names[id] ? { name: names[id] } : {}),
          windows: windows.map((w) => ({
            id: w.id,
            label: w.label,
            usedPercent: Math.round(w.usedPercent),
            ...(w.resetsAt !== undefined ? { resetsAt: new Date(w.resetsAt).toISOString() } : {}),
          })),
        }));
      if (provider !== undefined && snapshot.length === 0) {
        return { isError: true, content: [{ type: 'text' as const, text: `No usage reported for provider: ${provider}` }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ providers: snapshot }) }] };
    },
  );
}

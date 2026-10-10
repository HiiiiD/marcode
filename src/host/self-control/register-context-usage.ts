import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDeps } from './tool-deps';

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerContextUsageTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  mcp.registerTool(
    'marcode__get_context_usage',
    {
      title: 'How full is a session\'s context window',
      description: 'Marcode-specific: returns how much of the context window a session has used, as a '
        + '`percent`, plus `usedTokens`/`windowTokens` when the provider reports them. With no `name` it '
        + 'measures YOU — call it during long work to decide when to wrap up or hand off before the '
        + 'window runs out. Measured live when the provider allows, so it can lag by up to one model '
        + 'call; `stale: true` means the live query failed mid-turn and the figure is from the end of '
        + 'the previous turn, so the real value is higher. Unrelated to any built-in context command. '
        + 'Pass `name` (from marcode__list_sessions) to check a teammate instead.',
      inputSchema: z.object({
        name: z.string().optional().describe('Another session\'s name. Omit to measure yourself.'),
      }),
    },
    async ({ name }) => {
      let targetId: string | undefined;
      if (name === undefined) {
        targetId = caller()?.id;
        if (!targetId) { return fail('Could not identify the calling session.'); }
      } else {
        const visible = new Set(sessionManager.visibleIds());
        targetId = sessionManager.summaries()
          .find((s) => s.name.toLowerCase() === name.toLowerCase() && visible.has(s.id))?.id;
        if (!targetId) { return fail(`Unknown session: ${name}`); }
      }
      if (!sessionManager.contextBreakdown) { return fail('Context usage is not available in this window.'); }
      const res = await sessionManager.contextBreakdown(targetId);
      if (!res.ok) { return fail(res.reason); }
      const b = res.breakdown;
      const out = {
        percent: Math.round(100 - b.freePercent),
        ...(b.usedTokens !== undefined && b.windowTokens !== undefined
          ? { usedTokens: b.usedTokens, windowTokens: b.windowTokens } : {}),
        ...(res.stale ? { stale: true } : {}),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    },
  );
}

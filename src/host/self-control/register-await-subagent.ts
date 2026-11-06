import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ToolDeps } from './tool-deps';

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerAwaitSubagentTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  const service = sessionManager.subagents;
  if (!service) { return; }
  mcp.registerTool(
    'marcode__await_subagent',
    {
      title: 'Wait for a nested Marcode session',
      description: 'Marcode-specific: waits for a nested session you started with `nested: true` on marcode__spawn_session or marcode__spawn_collaborators and returns '
        + 'its final reply ({"ok", "text"}). Returns {"pending": true} if it is still running after `timeoutSec` '
        + '(default 45, max 3600); call again to keep waiting. Prefer ending your turn: the reply is delivered '
        + 'to you as a message when it finishes.',
      inputSchema: z.object({
        sessionId: z.string().describe('The sessionId returned when you spawned it.'),
        timeoutSec: z.number().optional().describe('How long to wait. Default 45, max 3600.'),
      }),
    },
    async ({ sessionId, timeoutSec }) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      const seconds = Math.min(Math.max(timeoutSec ?? 45, 1), 3600);
      const got = await service.awaitResult(from.id, sessionId, seconds * 1000);
      if (got === undefined) { return fail(`Unknown subagent: ${sessionId}`); }
      if (got === 'pending') { return { content: [{ type: 'text' as const, text: JSON.stringify({ pending: true }) }] }; }
      return { content: [{ type: 'text' as const, text: JSON.stringify(got) }] };
    },
  );
}

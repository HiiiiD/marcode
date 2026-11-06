import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { gateSpawn } from '../subagent/host-approval';
import { resolveSpawn } from './spawn-support';
import type { ToolDeps } from './tool-deps';

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerSubagentTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  const service = sessionManager.subagents;
  if (!service) { return; }
  mcp.registerTool(
    'marcode__spawn_subagent',
    {
      title: 'Delegate a task to a Marcode subagent',
      description: 'Marcode-specific: runs a task in a separate Marcode session on ANY provider/model and '
        + 'returns its final reply as this call\'s result. The subagent has no pane of its own: it shows as a '
        + 'nested card in this conversation, its tool approvals are answered right there, and it closes when '
        + 'it finishes. It is told you delegated to it and that its reply comes back automatically, so do not ask '
        + 'it to message you. Use it to hand off a bounded piece of work and get the answer inline; use '
        + 'marcode__spawn_session instead for independent, long-lived work that needs its own pane. Omitted '
        + 'provider, model, effort and mode inherit from you; `cwd` defaults to yours.',
      inputSchema: z.object({
        prompt: z.string().describe('The task for the subagent.'),
        provider: z.string().optional().describe('A provider id from this window\'s catalog. Omit to inherit yours.'),
        model: z.string().optional().describe('A model id (see marcode__list_models). Omit to inherit yours.'),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
          .describe('Effort level. Omit to inherit yours.'),
        mode: z.string().optional().describe('A permission mode id the provider offers. Omit to inherit yours.'),
        cwd: z.string().optional().describe('Absolute working directory. Omit to use yours.'),
        background: z.boolean().optional().describe(
          'Return a handle at once instead of waiting. The reply arrives later as a message from the subagent, '
          + 'or collect it with marcode__await_subagent.',
        ),
      }),
    },
    async ({ prompt, provider, model, effort, mode, cwd, background }, extra) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      const resolved = resolveSpawn(sessionManager, from, { provider, model, effort, mode, cwd: cwd ?? from.cwd });
      if (!resolved.ok) { return fail(resolved.error); }
      const approval = await gateSpawn(sessionManager, from, resolved, prompt);
      if (!approval.ok) { return fail(approval.error); }
      if (background) {
        const started = await service.runBackground(from.id, resolved.spawn, prompt);
        if (!started.ok) { return fail(started.text); }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: started.sessionId, background: true }) }] };
      }
      const result = await service.run(from.id, resolved.spawn, prompt, { signal: extra?.mcpReq?.signal });
      if (!result.ok) { return fail(result.text); }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  mcp.registerTool(
    'marcode__await_subagent',
    {
      title: 'Wait for a background Marcode subagent',
      description: 'Marcode-specific: waits for a subagent you started with marcode__spawn_subagent '
        + '`background: true` and returns its final reply. Returns {"pending": true} if it is still running '
        + 'after `timeoutSec` (default 600, max 3600); call again to keep waiting.',
      inputSchema: z.object({
        sessionId: z.string().describe('The sessionId returned by marcode__spawn_subagent.'),
        timeoutSec: z.number().optional().describe('How long to wait. Default 600, max 3600.'),
      }),
    },
    async ({ sessionId, timeoutSec }) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      const seconds = Math.min(Math.max(timeoutSec ?? 600, 1), 3600);
      const got = await service.awaitResult(from.id, sessionId, seconds * 1000);
      if (got === undefined) { return fail(`Unknown subagent: ${sessionId}`); }
      if (got === 'pending') { return { content: [{ type: 'text' as const, text: JSON.stringify({ pending: true }) }] }; }
      return { content: [{ type: 'text' as const, text: JSON.stringify(got) }] };
    },
  );
}

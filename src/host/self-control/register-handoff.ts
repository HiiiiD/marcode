import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openPane, resolveSpawn, sendPrompt } from './spawn-support';
import type { ToolDeps } from './tool-deps';

// Long enough for the tool result to reach the caller before close() disposes its run.
const CLOSE_DELAY_MS = 1500;

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerHandoffTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  mcp.registerTool(
    'marcode__handoff',
    {
      title: 'Hand this session off to a fresh one',
      description: 'Marcode-specific: moves your work to a brand-new session. Call it ONLY when the user '
        + 'explicitly asks for a handoff (or to continue in a fresh session) — never on your own initiative, '
        + 'not even when your context is filling up. Summarizes THIS conversation first, then creates a new '
        + 'top-level session with the same provider, model, effort, mode and working directory, whose first '
        + 'prompt is that summary plus your optional `note`, and opens it in a pane. The new session\'s '
        + 'parent is you. Your own session is closed shortly after this call returns, so finish or commit '
        + 'pending work first and do nothing else afterwards. Refused, with your session left untouched, '
        + 'if no summary can be produced or background tasks are still running.',
      inputSchema: z.object({
        note: z.string().optional().describe('What the new session should do first, beyond the summary.'),
      }),
    },
    async ({ note }) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      if (!sessionManager.handoffSummary) { return fail('Handoff is not available in this window.'); }
      if (from.backgroundTasks) {
        return fail(`${from.backgroundTasks} background task(s) are still running; let them finish or stop them first.`);
      }
      const summary = await sessionManager.handoffSummary(from.id);
      if (!summary) { return fail('Could not summarize this session, so it was not handed off.'); }
      const resolved = resolveSpawn(sessionManager, from, { cwd: from.cwd });
      if (!resolved.ok) { return fail(resolved.error); }
      const s = resolved.spawn;
      try {
        const session = await sessionManager.create(
          s.providerId, s.cwd, s.model, s.effort, s.mode, undefined, s.includeEditorContext, from.id,
        );
        const prompt = [
          `You are continuing the work of session "${from.name}", which ran out of context and handed off to you. `
            + 'It is your parent and is being closed; its transcript stays readable via marcode__recall_fetch.',
          note ? `Next step: ${note}` : 'Continue from where it left off.',
          `--- handoff from ${summary.title} ---\n${summary.text}\n--- end handoff from ${summary.title} ---`,
        ].join('\n\n');
        sendPrompt(session, prompt);
        await openPane(sessionManager, session.state.id);
        setTimeout(() => { void sessionManager.close(from.id).catch(() => undefined); }, CLOSE_DELAY_MS).unref();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: session.state.name }) }] };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

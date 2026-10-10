import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openPane, resolveSpawn, sendPrompt, type ResolvedSpawn } from './spawn-support';
import type { ToolDeps } from './tool-deps';
import { buildWorkerPreamble } from './worker-preamble';

const MAX_WORKERS = 8;

const fail = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text }] });

export function registerCollaboratorsTool(mcp: McpServer, { sessionManager, caller }: ToolDeps): void {
  mcp.registerTool(
    'marcode__spawn_collaborators',
    {
      title: 'Spawn a team of collaborator sessions',
      description: 'Marcode-specific: you become the lead of a small team. Creates one new top-level '
        + 'Marcode session per entry in `workers`, all in the SAME working tree (`cwd`, default: yours), '
        + 'each in its own pane. Every worker is told only about you and its teammates from this call — '
        + 'never about other sessions — plus its `scope` (files or folders it owns), safe git rules for a '
        + 'shared tree, and to report back to you with marcode__send_message. Workers commit their own '
        + 'files unless `commit` is false; they never push, only you do. Unlike marcode__spawn_session '
        + 'this is one call for the whole team. Not subagents of this conversation. Before you push, '
        + 'run `git status` and `git log` to confirm every worker finished and nothing is left dirty.',
      inputSchema: z.object({
        cwd: z.string().optional().describe('Absolute working directory shared by the team. Omit to use yours.'),
        workers: z.array(z.object({
          task: z.string().describe('What this worker should do.'),
          scope: z.string().optional().describe('Files or folders this worker owns; it is told not to edit outside.'),
          commit: z.boolean().optional().describe('Whether the worker commits its own files. Default true.'),
          provider: z.string().optional().describe('Provider id. Omit to inherit yours.'),
          model: z.string().optional().describe('Model id (see marcode__list_models). Omit to inherit yours.'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
            .describe('Effort level. Omit to inherit yours.'),
        })).min(1).max(MAX_WORKERS),
      }),
    },
    async ({ cwd, workers }) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      const teamCwd = cwd ?? from.cwd;
      const plans: ResolvedSpawn[] = [];
      for (const [i, w] of workers.entries()) {
        const r = resolveSpawn(sessionManager, from, { ...w, cwd: teamCwd });
        if (!r.ok) { return fail(`workers[${i}]: ${r.error}`); }
        plans.push(r.spawn);
      }
      const created: { id: string; name: string; session: unknown }[] = [];
      try {
        for (const s of plans) {
          const session = await sessionManager.create(s.providerId, s.cwd, s.model, s.effort, s.mode);
          created.push({ id: session.state.id, name: session.state.name, session });
        }
      } catch (err) {
        // Nothing was sent yet, so each is still empty and close discards it outright.
        for (const c of created) { await sessionManager.close(c.id).catch(() => undefined); }
        return fail(err instanceof Error ? err.message : String(err));
      }
      const team = created.map((c, i) => ({ name: c.name, task: workers[i].task }));
      for (const [i, c] of created.entries()) {
        sendPrompt(c.session, buildWorkerPreamble({
          lead: from.name,
          self: team[i],
          siblings: team.filter((_, j) => j !== i),
          scope: workers[i].scope,
          commit: workers[i].commit !== false,
        }));
        await openPane(sessionManager, c.id);
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            workers: team.map((t) => ({ sessionId: t.name, task: t.task })),
            note: 'Workers report back with marcode__send_message. Before pushing, run git status and git log.',
          }),
        }],
      };
    },
  );
}

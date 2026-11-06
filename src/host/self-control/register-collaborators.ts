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
        + 'never about other sessions — plus its `scope` (files or folders it owns), your optional `brief`, '
        + 'and safe git rules for a shared tree. Workers coordinate shared resources directly with each other '
        + 'via marcode__send_message and message you only for results, blockers or decisions. Workers commit their own '
        + 'files unless `commit` is false; they never push, only you do. Unlike marcode__spawn_session '
        + 'this is one call for the whole team. Before you push, '
        + 'run `git status` and `git log` to confirm every worker finished and nothing is left dirty.',
      inputSchema: z.object({
        brief: z.string().optional().describe('Shared context and rules for the whole team, given to every worker (e.g. how to take turns on a shared device).'),
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
        nested: z.boolean().optional().describe(
          'Run the workers nested inside this conversation (no panes, cards here, approvals answered here, each reply '
          + 'arrives as a message to you) instead of one pane each. Workers can still message each other and you.',
        ),
      }),
    },
    async ({ cwd, brief, workers, nested }) => {
      const from = caller();
      if (!from) { return fail('Could not identify the calling session.'); }
      const teamCwd = cwd ?? from.cwd;
      const plans: ResolvedSpawn[] = [];
      for (const [i, w] of workers.entries()) {
        const r = resolveSpawn(sessionManager, from, { ...w, cwd: teamCwd });
        if (!r.ok) { return fail(`workers[${i}]: ${r.error}`); }
        plans.push(r.spawn);
      }
      const service = sessionManager.subagents;
      if (nested) {
        if (!service) { return fail('Nested workers are not available in this window.'); }
        const children = [];
        for (const s of plans) {
          const prepared = await service.prepare(from.id, s);
          if (!prepared.ok) {
            for (const c of children) { await service.discard(c.state.id); }
            return fail(prepared.text);
          }
          children.push(prepared.child);
        }
        const members = children.map((c, i) => ({ name: c.state.name, task: workers[i].task }));
        for (const [i, c] of children.entries()) {
          service.start(from.id, c, workers[i].task, buildWorkerPreamble({
            lead: from.name,
            self: members[i],
            siblings: members.filter((_, j) => j !== i),
            scope: workers[i].scope,
            brief,
            commit: workers[i].commit !== false,
            nested: true,
          }));
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              workers: members.map((t) => ({ sessionId: t.name, task: t.task })),
              nested: true,
              note: 'Each worker\'s reply arrives as a message. Before pushing, run git status and git log.',
            }),
          }],
        };
      }
      const created: { id: string; name: string; session: unknown }[] = [];
      try {
        for (const s of plans) {
          const session = await sessionManager.create(s.providerId, s.cwd, s.model, s.effort, s.mode, undefined, s.includeEditorContext, caller()?.id);
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
          brief,
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

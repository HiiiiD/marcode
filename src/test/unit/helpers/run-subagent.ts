import type { SessionManager } from '../../../host/session-manager';
import type { SubagentResult } from '../../../host/subagent/subagent-bridge';

type Spec = Parameters<SessionManager['subagents']['runBackground']>[1];

/** Starts a subagent and waits for it to finish, the way a test wants a result. */
export async function runSubagent(
  manager: Pick<SessionManager, 'subagents'>, parentId: string, spec: Spec, prompt: string,
): Promise<SubagentResult> {
  const started = await manager.subagents.runBackground(parentId, spec, prompt);
  if (!started.ok) { return { ok: false, text: started.text, sessionId: '' }; }
  const got = await manager.subagents.awaitResult(parentId, started.sessionId, 10_000);
  return typeof got === 'object' ? got : { ok: false, text: 'still running', sessionId: started.sessionId };
}

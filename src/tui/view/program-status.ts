import type { SessionSummary } from '../../protocol/messages';

export type ProgramStatusReport =
  | { state: 'idle' }
  | { state: 'working'; app: string; message: string }
  | { state: 'blocked'; kind: 'permission' | 'question'; app: string; title: string; message: string }
  | { state: 'error'; app: string; message: string };

const APP = 'marcode';

export function programStatus(sessions: readonly SessionSummary[]): ProgramStatusReport {
  const waiting = sessions.filter((s) => s.status === 'awaiting-approval');
  if (waiting.length > 0) {
    const first = waiting[0]!;
    const name = first.name || first.title;
    const questions = waiting.every((s) => s.waitingOn === 'question');
    const noun = questions ? 'an answer' : 'approval';
    return {
      state: 'blocked', kind: questions ? 'question' : 'permission', app: APP, title: name,
      message: waiting.length === 1 ? `${name} awaits ${noun}` : `${waiting.length} sessions await ${noun}`,
    };
  }
  const running = sessions.filter((s) => s.status === 'running').length;
  if (running > 0) {
    return { state: 'working', app: APP, message: running === 1 ? '1 session running' : `${running} sessions running` };
  }
  return { state: 'idle' };
}

export const programStatusKey = (r: ProgramStatusReport): string => JSON.stringify(r);

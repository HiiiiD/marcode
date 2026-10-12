// Subagent instance ids are `a` + 16 hex; a subagent id is never a session even if a session were named alike.
const SUBAGENT_ID = /^a[0-9a-f]{16}$/;

export function sendMessageDenial(input: unknown, isSessionHandle: (target: string) => boolean): string | undefined {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const target = typeof record.to === 'string' ? record.to : typeof record.recipient === 'string' ? record.recipient : undefined;
  if (target === undefined || SUBAGENT_ID.test(target.trim()) || !isSessionHandle(target)) { return undefined; }
  return `"${target}" is another session, not a subagent. SendMessage only reaches subagents you spawned; `
    + 'to message another session use the marcode__send_message tool (find it with marcode__list_sessions).';
}

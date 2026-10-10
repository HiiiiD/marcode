import type { ShellItem, TranscriptItem } from '../protocol/messages';

type ToolItem = Extract<TranscriptItem, { role: 'tool' }>;

/** A `!` command rendered as a tool call labelled "User shell", so the sidebar reuses the tool card while keeping it distinct from the agent's Bash calls. */
export function shellAsTool(item: ShellItem): ToolItem {
  const notes: string[] = [];
  if (item.error) { notes.push(item.error); }
  else if (item.state === 'cancelled') { notes.push('cancelled'); }
  else if (item.timedOut) { notes.push('timed out'); }
  else if (item.signal) { notes.push(`signal ${item.signal}`); }
  else if (item.exitCode) { notes.push(`exit ${item.exitCode}`); }
  if (item.truncated) { notes.push('output truncated'); }
  const status = notes.map((n) => `[${n}]`).join('\n');
  const body = item.output.replace(/\n+$/, '') === '' ? '' : item.output;
  const text = status === '' ? body : body === '' ? status : `${body.replace(/\n+$/, '')}\n\n${status}`;
  const failed = item.state === 'done'
    && (Boolean(item.error) || item.timedOut === true || Boolean(item.signal) || (item.exitCode ?? 0) !== 0);
  return {
    id: item.id, ts: item.ts, role: 'tool', toolId: item.id,
    tool: { kind: 'command', label: 'User shell', command: item.command },
    state: item.state === 'running' ? 'running' : failed ? 'error' : 'ok',
    output: text === '' ? { kind: 'none' } : { kind: 'text', text },
  };
}

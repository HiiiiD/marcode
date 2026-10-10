import type { ShellItem } from '../protocol/messages';

export interface ShellCardModel {
  command: string;
  output: string;
  running: boolean;
  failed: boolean;
  footer: string;
}

export function shellCard(item: ShellItem): ShellCardModel {
  const running = item.state === 'running';
  const parts: string[] = [];
  if (running) { parts.push('running…'); }
  else if (item.state === 'cancelled') { parts.push('cancelled'); }
  else if (item.error) { parts.push(item.error); }
  else if (item.timedOut) { parts.push('timed out'); }
  else if (item.signal) { parts.push(`signal ${item.signal}`); }
  else if (item.exitCode !== undefined) { parts.push(`exit ${item.exitCode}`); }
  if (item.truncated) { parts.push('output truncated'); }
  const failed = !running && item.state !== 'cancelled'
    && (Boolean(item.error) || item.timedOut === true || Boolean(item.signal) || (item.exitCode ?? 0) !== 0);
  return { command: item.command, output: item.output, running, failed, footer: parts.join(' · ') };
}

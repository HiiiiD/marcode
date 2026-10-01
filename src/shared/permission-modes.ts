import type { PermissionMode, PermissionModeInfo } from '../protocol/messages';

export interface ModeRow { value: PermissionMode; label: string; description: string }

export const MODES: ModeRow[] = [
  { value: 'default', label: 'Ask', description: 'Approve every tool call before it runs.' },
  { value: 'acceptEdits', label: 'Auto-edit', description: 'File edits apply on their own. Everything else still asks.' },
  { value: 'auto', label: 'Auto', description: 'The agent judges each call and only asks about the risky ones.' },
  { value: 'plan', label: 'Plan', description: 'Read and propose. Nothing on disk is changed.' },
  { value: 'dontAsk', label: 'Deny', description: 'Refuse anything not already allowed, without prompting.' },
  { value: 'bypass', label: 'Bypass', description: 'Run everything without asking. Chosen before the first message.' },
];

export const MODE_OF = (mode: PermissionMode): ModeRow => MODES.find((m) => m.value === mode) ?? MODES[0]!;

// An empty declaration means the catalog has not loaded yet, so every row is shown rather than none.
export function modesFor(declared: PermissionModeInfo[] | undefined): ModeRow[] {
  if (!declared || declared.length === 0) { return MODES; }
  const byId = new Map(declared.map((d) => [d.id, d]));
  return MODES
    .filter((m) => byId.has(m.value))
    .map((m) => {
      const description = byId.get(m.value)?.description;
      return description ? { ...m, description } : m;
    });
}

export function modeRowsForProvider(providerId: string | undefined, declared: PermissionModeInfo[] | undefined): ModeRow[] {
  const rows = modesFor(declared);
  if (providerId !== 'opencode') { return rows; }
  return rows.map((row) => row.value === 'default'
    ? { ...row, label: 'Build', description: 'OpenCode decides permissions using your opencode.json.' }
    : row);
}

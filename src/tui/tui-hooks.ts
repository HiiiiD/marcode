import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitCommandLine } from '../client-core/mcp/split-command';
import type { ConfigHost, EditorContextHost } from '../host/message-router';

type Spawner = (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, 'on' | 'unref'>;

/**
 * Hands a pending plan to the configured editor command; with none configured the plan stays in the card.
 * The path is agent-controlled, so it is its own argv entry and never passes through a shell.
 */
export function planOpener(command: string | undefined, run: Spawner = spawn): EditorContextHost['openPlan'] {
  const parsed = command ? splitCommandLine(command) : undefined;
  if (!parsed || 'error' in parsed) { return () => {}; }
  return (text, planPath) => {
    try {
      const file = planPath ?? join(mkdtempSync(join(tmpdir(), 'marcode-plan-')), 'plan.md');
      if (!planPath) { writeFileSync(file, text); }
      const child = run(parsed.command, [...parsed.args, file], { shell: false, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } catch { /* a plan that cannot be opened is still answerable in the card */ }
  };
}

export function terminalEditorHost(onLogin: (providerId: string) => void, planEditor?: string): EditorContextHost {
  return {
    current: () => null,
    reveal: () => {},
    openDiff: () => {},
    openSettings: () => {},
    openExternal: () => {},
    openPlan: planOpener(planEditor),
    exportCsv: () => {},
    exportImage: () => {},
    login: onLogin,
  };
}

export function terminalConfigHost(setFavorites: (ids: string[]) => void): ConfigHost {
  return { setFavoriteModels: setFavorites };
}

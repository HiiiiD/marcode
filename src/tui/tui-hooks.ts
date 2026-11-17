import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigHost, EditorContextHost } from '../host/message-router';

/** Hands a pending plan to the configured editor command; with none configured the plan stays in the card. */
export function planOpener(command: string | undefined): EditorContextHost['openPlan'] {
  if (!command) { return () => {}; }
  return (text, planPath) => {
    try {
      const file = planPath ?? join(mkdtempSync(join(tmpdir(), 'marcode-plan-')), 'plan.md');
      if (!planPath) { writeFileSync(file, text); }
      spawn(`${command} "${file}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
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

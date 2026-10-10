import * as vscode from 'vscode';
import { runAccountSetupWizard } from './account-setup-wizard';
import { awaitMessage } from './await-message';
import { openLoginTerminal } from './editor-actions';
import type { FleetPanel } from './fleet-panel';
import type { HistoryPanel } from './history-panel';
import { runMemoryReindex, type ReindexIo } from './memory-reindex-flow';
import { PANE_COMMANDS, paneCommandMessage } from './pane-commands';
import type { PanelViewProvider } from './panel-view-provider';
import type { ReviewPanel } from './review-panel';
import type { HostConnection, SurfaceLink } from './surface-link';
import { KNOWN_PROVIDER_IDS } from '../shared/settings';

export interface CommandDeps {
  configFile: string;
  provider: PanelViewProvider;
  review: ReviewPanel;
  fleet: FleetPanel;
  history: HistoryPanel;
  connection: HostConnection;
}

const ESTIMATE_WAIT_MS = 3_000;
const STATUS_WAIT_MS = 5_000;
const REINDEX_WAIT_MS = 30 * 60_000;

function reindexIo(link: SurfaceLink): ReindexIo {
  const { transport } = link;
  return {
    status: async () => {
      const wait = awaitMessage(transport, (m) => m.t === 'memory-status', STATUS_WAIT_MS);
      transport.post({ t: 'request-memory-status' });
      const m = await wait;
      if (m?.t !== 'memory-status') { throw new Error('the background host did not answer (it may be an older build)'); }
      return { enabled: m.enabled, llm: m.llm };
    },
    estimate: async () => {
      const wait = awaitMessage(
        transport, (m) => m.t === 'memory-estimate' || (m.t === 'memory-progress' && m.phase === 'done'), ESTIMATE_WAIT_MS,
      );
      transport.post({ t: 'memory-estimate', scope: 'missing-llm' });
      const m = await wait;
      return m?.t === 'memory-estimate' ? { sessions: m.sessions, approxInputTokens: m.approxInputTokens } : undefined;
    },
    confirm: async (detail) => {
      const start = 'Start';
      return (await vscode.window.showInformationMessage(detail, { modal: true }, start)) === start;
    },
    reindex: async () => {
      const wait = awaitMessage(
        transport, (m) => m.t === 'memory-progress' && (m.phase === 'done' || m.phase === 'cancelled'), REINDEX_WAIT_MS,
      );
      transport.post({ t: 'memory-reindex', scope: 'missing-llm' });
      await wait;
    },
    info: (message) => { void vscode.window.showInformationMessage(message); },
  };
}

async function reindexMemory(connection: HostConnection): Promise<void> {
  const link = await connection.connect('history');
  try {
    await runMemoryReindex(reindexIo(link));
  } catch (err) {
    void vscode.window.showErrorMessage(`Memory reindex failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    link.dispose();
  }
}

export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const openConfig = () => { void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(d.configFile)); };
  return [
    ...PANE_COMMANDS.map((command) => vscode.commands.registerCommand(command, () => {
      const layout = d.provider.layout();
      const msg = layout ? paneCommandMessage(command, layout) : undefined;
      if (msg) { d.provider.post(msg); }
    })),
    vscode.commands.registerCommand('marcode.review.open', () => { d.review.open(); }),
    vscode.commands.registerCommand('marcode.fleet.open', () => { d.fleet.open(); }),
    vscode.commands.registerCommand('marcode.history.open', () => { d.history.open(); }),
    vscode.commands.registerCommand('marcode.config.open', openConfig),
    vscode.commands.registerCommand('marcode.memory.reindex', () => reindexMemory(d.connection)),
    vscode.commands.registerCommand('marcode.login', async () => {
      const picks = [...d.connection.loginRecipes.entries()]
        .map(([id, recipe]) => ({ label: recipe.terminalName, description: id, recipe }));
      if (picks.length === 0) {
        void vscode.window.showInformationMessage('No provider instance has a login flow.');
        return;
      }
      const pick = picks.length === 1
        ? picks[0]
        : await vscode.window.showQuickPick(picks, { placeHolder: 'Sign in to which provider instance?' });
      if (pick) { openLoginTerminal(pick.recipe.terminalName, pick.recipe.command, pick.recipe.env); }
    }),
    vscode.commands.registerCommand('marcode.accountSetup.wizard', () => {
      void runAccountSetupWizard(KNOWN_PROVIDER_IDS, d.configFile);
    }),
  ];
}

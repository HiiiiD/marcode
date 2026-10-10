import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { spawnDetached } from '../daemon-client/spawn-daemon';
import { reloadSignature } from './host-config';
import { setLifecycleDebug } from '../shared/lifecycle-debug';
import { importPreviousStorage, legacySettings, showCacheTimer, warnAboutProfile } from './activation-support';
import { AgentsMdNudgeController, buildExcludeGlob } from './agents-md-nudge';
import { registerCommands } from './commands';
import { configPath, favoriteModelsSource, loadConfig, seedConfigFileSafely, watchConfig } from './config-file';
import { defaultCwdOf } from './default-cwd';
import { registerDiffContentProvider } from './diff-content-provider';
import { EditorContextTracker } from './editor-context-tracker';
import { FleetPanel, FLEET_VIEW_TYPE } from './fleet-panel';
import { HistoryPanel, HISTORY_VIEW_TYPE } from './history-panel';
import { openHostConnection } from './host-connection';
import { PanelViewProvider } from './panel-view-provider';
import { ReviewPanel, REVIEW_VIEW_TYPE } from './review-panel';
import type { HostConnection } from './surface-link';
import { createVscodeEditorSource } from './vscode-editor-source';
import { createVscodeHooks } from './vscode-hooks';
import { createWorkspaceFileIndex } from './workspace-file-index';
import { marcodeHome, resolveWorkspaceDirOr } from './workspace-dir';

/** `context.workspaceState` key for dirs the AGENTS.md/CLAUDE.md nudge has resolved or dismissed. */
const DISMISSED_AGENTS_MD_KEY = 'marcode.agentsmdNudge.dismissed';

/**
 * `deactivate()` is the one hook VS Code awaits before tearing the extension host down; a
 * subscription's `dispose()` returns void, so a flush started there can be cut off. The in-process
 * host flushes buffered transcript writes in `dispose()`, so it is awaited from here. With a daemon
 * attached this only closes sockets: the agents are meant to outlive the window.
 */
let pendingDeactivate: (() => Promise<void>) | undefined;

export async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  setLifecycleDebug(vscode.workspace.getConfiguration('marcode').get<boolean>('debug', false));
  const home = marcodeHome();
  const configFile = configPath(home);
  const seeded = await seedConfigFileSafely(configFile, legacySettings());
  if (seeded.warning) { void vscode.window.showWarningMessage(seeded.warning); }
  const { config, warnings: configWarnings } = await loadConfig(configFile);
  for (const warning of configWarnings) { void vscode.window.showWarningMessage(warning); }

  const resolved = await resolveWorkspaceDirOr(
    home, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, (context.storageUri ?? context.globalStorageUri).fsPath,
  );
  if (resolved.warning) { void vscode.window.showWarningMessage(resolved.warning); }
  const workspaceDir = resolved.dir;
  await importPreviousStorage(context, workspaceDir);

  // Never `process.cwd()`: for an extension host that is VS Code's own install directory.
  const resolvedCwd = defaultCwdOf(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath), os.homedir());
  const defaultCwd = resolvedCwd.cwd;
  if (resolvedCwd.fallback) {
    void vscode.window.showWarningMessage(
      `No folder is open, so agent sessions will run in ${defaultCwd}. Open a folder to run them in your project.`,
    );
  }

  const editorSource = createVscodeEditorSource();
  const tracker = new EditorContextTracker(editorSource);
  const favorites = favoriteModelsSource(
    configFile, config.favoriteModels, (m) => { void vscode.window.showWarningMessage(m); },
  );
  const fileIndex = createWorkspaceFileIndex(defaultCwd);
  let connection: HostConnection | undefined;
  const hooks = createVscodeHooks({
    configFile, loginRecipes: () => connection?.loginRecipes ?? new Map(), fileSearch: fileIndex, favorites, tracker,
  });

  // The daemon reports an update once per `ready`; this keeps the per-window dedup the in-process hook has.
  const shownUpdates = new Set<string>();
  connection = await openHostConnection({
    workspaceDir, config, roots: () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
    defaultCwd, configSignature: reloadSignature(config), hooks, showCacheTimer: showCacheTimer(),
    favoriteModels: () => favorites.get(), context: () => tracker.current,
    notices: {
      info: (text) => {
        if (shownUpdates.has(text)) { return; }
        shownUpdates.add(text);
        void vscode.window.showInformationMessage(text);
      },
      warn: (text) => { void vscode.window.showWarningMessage(text); },
      shellNoise: warnAboutProfile,
    },
    spawn: (dir, roots) => spawnDetached(dir, roots, { script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'daemon.js').fsPath }),
  });
  const host = connection;
  if (host.fallbackNotice) { void vscode.window.showWarningMessage(host.fallbackNotice); }
  for (const warning of host.warnings) { void vscode.window.showWarningMessage(warning); }

  const review = new ReviewPanel(context.extensionUri, () => host.connect('review'));
  const fleet = new FleetPanel(context.extensionUri, () => host.connect('fleet'));
  const history = new HistoryPanel(context.extensionUri, () => host.connect('history'));

  const agentsMdNudge = new AgentsMdNudgeController({
    findRelativePaths: async () => {
      const excludePaths = vscode.workspace.getConfiguration('marcode').get<string[]>('agentsMdNudge.excludePaths', []);
      const uris = await vscode.workspace.findFiles('**/{CLAUDE.md,AGENTS.md}', buildExcludeGlob(excludePaths));
      return uris.map((u) => vscode.workspace.asRelativePath(u, false).split(path.sep).join('/'));
    },
    hasClaudeProvider: config.enabledProviders.includes('claude'),
    dismiss: {
      get: () => new Set(context.workspaceState.get<string[]>(DISMISSED_AGENTS_MD_KEY, [])),
      add: async (dirs) => {
        const current = new Set(context.workspaceState.get<string[]>(DISMISSED_AGENTS_MD_KEY, []));
        for (const dir of dirs) { current.add(dir); }
        await context.workspaceState.update(DISMISSED_AGENTS_MD_KEY, [...current]);
      },
    },
    resolvePaths: (dir) => ({
      claudeMdPath: path.join(defaultCwd, dir, 'CLAUDE.md'),
      agentsMdPath: path.join(defaultCwd, dir, 'AGENTS.md'),
    }),
    fs: {
      readFile: async (p) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(p))),
      writeFile: async (p, content) => {
        await vscode.workspace.fs.writeFile(vscode.Uri.file(p), new TextEncoder().encode(content));
      },
    },
    // Assigned below, before this can run: the scan fires from resolveWebviewView.
    post: (m) => provider.post(m),
  });

  const provider: PanelViewProvider = new PanelViewProvider(
    context.extensionUri, () => host.connect('sidebar'), host.attachmentsBaseDir,
    {
      openReview: () => { review.open(); },
      openHistory: () => { history.open(); },
      openFleet: (focus) => { fleet.open(focus); },
    },
    agentsMdNudge, showCacheTimer(),
  );
  const contextSub = tracker.onChange((ctx) => provider.pushContext(ctx));

  const watcher = watchConfig(configFile, config, () => {
    const reload = 'Reload window';
    void vscode.window.showInformationMessage('Marcode settings changed. Reload the window to apply them.', reload)
      .then((choice) => {
        if (choice === reload) { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
      });
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    registerDiffContentProvider(),
    { dispose: () => { void host.dispose(); } },
    { dispose: () => { watcher.dispose(); } },
    { dispose: () => { contextSub.dispose(); tracker.dispose(); editorSource.dispose(); } },
    fileIndex,
    ...registerCommands({ configFile, provider, review, fleet, history, connection: host }),
    // Without a serializer VS Code restores the tab as a blank webview.
    vscode.window.registerWebviewPanelSerializer(REVIEW_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { review.restore(panel); },
    }),
    vscode.window.registerWebviewPanelSerializer(FLEET_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { fleet.restore(panel); },
    }),
    vscode.window.registerWebviewPanelSerializer(HISTORY_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { history.restore(panel); },
    }),
    { dispose: () => { history.dispose(); } },
    { dispose: () => { review.dispose(); } },
    { dispose: () => { fleet.dispose(); } },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('marcode.debug')) {
        setLifecycleDebug(vscode.workspace.getConfiguration('marcode').get<boolean>('debug', false));
      }
    }),
  );

  pendingDeactivate = () => host.dispose();
}

export async function deactivateExtension(): Promise<void> {
  await pendingDeactivate?.();
}

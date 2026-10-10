import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runAccountSetupWizard } from './host/account-setup-wizard';
import { AgentsMdNudgeController, buildExcludeGlob } from './host/agents-md-nudge';
import { defaultCwdOf } from './host/default-cwd';
import { registerDiffContentProvider } from './host/diff-content-provider';
import { openLoginTerminal } from './host/editor-actions';
import { createVscodeHooks } from './host/vscode-hooks';
import { EditorContextTracker } from './host/editor-context-tracker';
import { FleetPanel, FLEET_VIEW_TYPE } from './host/fleet-panel';
import { HistoryPanel, HISTORY_VIEW_TYPE } from './host/history-panel';
import { PanelViewProvider } from './host/panel-view-provider';
import { PostBus } from './host/post-bus';
import { PROFILE_GUARD_SNIPPET } from './host/profile-noise';
import { ReviewPanel, REVIEW_VIEW_TYPE } from './host/review-panel';
import { createVscodeEditorSource } from './host/vscode-editor-source';
import { createWorkspaceFileIndex } from './host/workspace-file-index';
import { PANE_COMMANDS, paneCommandMessage } from './host/pane-commands';
import { KNOWN_PROVIDER_IDS } from './shared/settings';
import { setLifecycleDebug } from './shared/lifecycle-debug';
import { configPath, favoriteModelsSource, loadConfig, seedConfigFileSafely, watchConfig } from './host/config-file';
import { createHost } from './host/create-host';
import { importOldStorage } from './host/migrate-storage';
import { marcodeHome, resolveWorkspaceDirOr } from './host/workspace-dir';

/**
 * `marcode.showCacheTimer` — off by default. See package.json's description
 * and CacheTimer's doc comment for why: the badge is a self-computed
 * approximation (anchored at receipt, not confirmed by a later server read),
 * and showing it unconditionally would present that approximation as fact to
 * users who never asked for it.
 */
function showCacheTimer(): boolean {
  return vscode.workspace.getConfiguration('marcode').get<boolean>('showCacheTimer', false);
}

const LEGACY_KEYS = [
  'enabledProviders', 'providerInstances', 'systemPrompts', 'codex.path', 'opencode.path', 'usageMirrors',
  'memory.enabled', 'memory.summarizer', 'review.fileCap', 'review.pollIntervalMs', 'review.baseRefs', 'favoriteModels',
];

/** Explicit values a user set under the old VS Code setting ids, for the one-time `config.json` seed. */
function legacySettings(): Record<string, unknown> {
  const cfg = vscode.workspace.getConfiguration('marcode');
  const out: Record<string, unknown> = {};
  for (const key of LEGACY_KEYS) {
    const info = cfg.inspect<unknown>(key);
    const value = info?.workspaceFolderValue ?? info?.workspaceValue ?? info?.globalValue;
    if (value !== undefined) { out[key] = value; }
  }
  return out;
}

/**
 * Awaited before the host exists, and without asking: the copy never touches the old directory,
 * and a consent toast awaited here would hold up the panel, while one answered after the host
 * started would merge into an `index.json` the host is already rewriting. Only the report is a toast.
 */
async function importPreviousStorage(context: vscode.ExtensionContext, workspaceDir: string): Promise<void> {
  const oldDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const result = await importOldStorage(oldDir, workspaceDir);
  if (result.kind === 'failed') { void vscode.window.showWarningMessage(result.reason); }
  if (result.kind === 'imported') {
    void vscode.window.showInformationMessage(
      `Imported ${result.sessions} Marcode session${result.sessions === 1 ? '' : 's'} into ~/.marcode. The originals were copied, not moved.`,
    );
  }
}

/**
 * One warning per window, not per session and not per command.
 *
 * Deliberately not persisted: the condition is a live property of the user's
 * shell, so a flag on disk would silence the advice for an install that is
 * still broken. A window is the smallest scope that does not nag.
 */
let profileWarned = false;

/** `context.workspaceState` key for dirs the AGENTS.md/CLAUDE.md nudge has resolved or dismissed. */
const DISMISSED_AGENTS_MD_KEY = 'marcode.agentsmdNudge.dismissed';

/**
 * Tells the user their PowerShell profile is being loaded — and failing — for
 * every command Codex runs, and hands them the fix.
 *
 * Nothing here can repair it: Codex wraps commands as `pwsh.exe -Command "…"`
 * with no `-NoProfile` and that invocation is not ours to change, so the
 * profile is the only place the guard can go. See `host/profile-noise.ts`.
 */
function warnAboutProfile(profile: string): void {
  if (profileWarned) { return; }
  profileWarned = true;
  const copy = 'Copy fix';
  void vscode.window.showWarningMessage(
    `Your PowerShell profile fails to load when Codex runs a command, and its errors `
      + `end up in the agent's output. Commands still succeed. Guard the console-only `
      + `parts of ${profile} to silence it.`,
    copy,
  ).then((choice) => {
    if (choice !== copy) { return; }
    void vscode.env.clipboard.writeText(PROFILE_GUARD_SNIPPET);
  });
}

/**
 * `deactivate()` is the one hook VS Code actually awaits (up to a timeout)
 * before tearing down the extension host — on "Reload Window" that teardown
 * can happen shortly after. `context.subscriptions`' own `dispose()` calls
 * are NOT awaited by VS Code: a subscription's `dispose()` returns `void`,
 * so a `{ dispose: () => { void manager.dispose(); } }` entry discards the
 * very promise that would let anyone wait for it. `SessionManager.dispose()`
 * flushes every live session's buffered transcript writes to disk (see
 * `AgentSession.dispose()` -> `scheduleFlush()`), so racing it against
 * process teardown is exactly how a subagent's just-settled tool calls (or
 * any other pending write) get lost on reload. Captured here and awaited in
 * `deactivate()` so the flush actually finishes first; the subscriptions
 * below still call `dispose()` too, but that is a harmless no-op on an
 * already-disposed manager (see `SessionManager.dispose()`'s own guard),
 * kept as a backstop for host shutdown paths that skip `deactivate()`.
 */
let pendingDeactivate: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext) {
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

  let provider: PanelViewProvider;
  const bus = new PostBus();
  const host = await createHost({
    workspaceDir, config, hostKind: 'vscode',
    workspaceRoots: () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
    emit: (msg) => bus.post(msg),
    notify: { warn: (m) => { void vscode.window.showWarningMessage(m); } },
    onShellNoise: warnAboutProfile,
  });
  const { manager, attachments, enabled, loginRecipes } = host;

  // Never `process.cwd()` — for an extension host that is VS Code's own
  // install directory, and a session inherits it silently. See
  // `host/default-cwd.ts`.
  const resolvedCwd = defaultCwdOf(
    vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath),
    os.homedir(),
  );
  const defaultCwd = resolvedCwd.cwd;
  if (resolvedCwd.fallback) {
    // Visible, not silent: the alternative is an agent quietly reading and
    // writing somewhere the user never chose.
    void vscode.window.showWarningMessage(
      `No folder is open, so agent sessions will run in ${defaultCwd}. `
        + 'Open a folder to run them in your project.',
    );
  }

  const editorSource = createVscodeEditorSource();
  const tracker = new EditorContextTracker(editorSource);

  const favorites = favoriteModelsSource(
    configFile, config.favoriteModels, (m) => { void vscode.window.showWarningMessage(m); },
  );
  const fileIndex = createWorkspaceFileIndex(defaultCwd);
  const hooks = createVscodeHooks({
    configFile, loginRecipes: () => loginRecipes, fileSearch: fileIndex, favorites, tracker,
  });
  const { editor: editorHost, picker, configHost, updateNotify } = hooks;

  const review = new ReviewPanel(
    context.extensionUri, manager, bus, defaultCwd, editorHost, config.review.pollIntervalMs,
  );
  const fleet = new FleetPanel(context.extensionUri, manager, bus, defaultCwd, editorHost);
  const history = new HistoryPanel(context.extensionUri, manager, bus, defaultCwd, editorHost);

  const agentsMdNudge = new AgentsMdNudgeController({
    findRelativePaths: async () => {
      const excludePaths = vscode.workspace.getConfiguration('marcode')
        .get<string[]>('agentsMdNudge.excludePaths', []);
      const uris = await vscode.workspace.findFiles(
        '**/{CLAUDE.md,AGENTS.md}',
        buildExcludeGlob(excludePaths),
      );
      return uris.map((u) => vscode.workspace.asRelativePath(u, false).split(path.sep).join('/'));
    },
    hasClaudeProvider: enabled.has('claude'),
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
    // provider is assigned below, before this ever runs (scan fires from
    // resolveWebviewView, which only happens once VS Code shows the panel).
    post: (m) => provider.post(m),
  });

  provider = new PanelViewProvider(
    context.extensionUri, manager, defaultCwd, editorHost, attachments, picker,
    () => { review.open(); },
    (focus) => { fleet.open(focus); },
    fileIndex,
    agentsMdNudge,
    () => favorites.get(),
    configHost,
    updateNotify,
    showCacheTimer(),
    () => { history.open(); },
  );
  // The sidebar is the client that wants everything. Registered here rather
  // than inside PanelViewProvider so there is one place that says which
  // surfaces exist and what each of them sees.
  bus.add({ post: (msg) => provider.post(msg), wants: () => true });

  // Push every change to the webview so the composer chip tracks the editor.
  const contextSub = tracker.onChange((ctx) => provider.post({ t: 'editor-context', ctx }));

  const watcher = watchConfig(configFile, config, () => {
    const reload = 'Reload window';
    void vscode.window.showInformationMessage(
      'Marcode settings changed. Reload the window to apply them.',
      reload,
    ).then((choice) => {
      if (choice !== reload) { return; }
      void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    registerDiffContentProvider(),
    { dispose: () => { void host.dispose(); } },
    { dispose: () => { watcher.dispose(); } },
    { dispose: () => { contextSub.dispose(); tracker.dispose(); editorSource.dispose(); } },
    fileIndex,
    ...PANE_COMMANDS.map((command) => vscode.commands.registerCommand(command, () => {
      const msg = paneCommandMessage(command, manager.layout());
      if (msg) { provider.post(msg); }
    })),
    vscode.commands.registerCommand('marcode.review.open', () => { review.open(); }),
    vscode.commands.registerCommand('marcode.fleet.open', () => { fleet.open(); }),
    vscode.commands.registerCommand('marcode.history.open', () => { history.open(); }),
    vscode.commands.registerCommand('marcode.config.open', () => {
      void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configFile));
    }),
    vscode.commands.registerCommand('marcode.memory.reindex', async () => {
      const status = manager.memoryStatus();
      if (!status.enabled) {
        void vscode.window.showInformationMessage('Marcode memory is off (marcode.memory.enabled).');
        return;
      }
      let detail = 'Rebuild the memory index for every session (no model used for this step).';
      const est = status.llm ? await manager.memoryEstimate('missing-llm') : undefined;
      if (est && est.sessions > 0) {
        detail += ` Then summarize ${est.sessions} hidden sessions with the configured model `
          + `(about ${Math.round(est.approxInputTokens / 1000)}k input tokens). This costs model usage.`;
      } else if (est) {
        detail += ' Every hidden session already has a current model summary, so no model calls will be made.';
      } else {
        detail += ' No summarizer is configured, so no model calls will be made.';
      }
      const start = 'Start';
      if (await vscode.window.showInformationMessage(detail, { modal: true }, start) !== start) { return; }
      void manager.memoryReindex('missing-llm').then(() => {
        void vscode.window.showInformationMessage('Marcode memory reindex finished.');
      });
    }),
    // Without a serializer VS Code restores the tab as a blank webview, which
    // is worse than not restoring it. The host owns whether the tab exists;
    // the client owns nothing durable, so re-attaching is the whole job.
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
    vscode.commands.registerCommand('marcode.login', async () => {
      const picks = [...loginRecipes.entries()].map(([id, recipe]) => ({ label: recipe.terminalName, description: id, recipe }));
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
      void runAccountSetupWizard(KNOWN_PROVIDER_IDS, configFile);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('marcode.debug')) {
        setLifecycleDebug(vscode.workspace.getConfiguration('marcode').get<boolean>('debug', false));
      }
    }),
  );

  pendingDeactivate = async () => {
    await host.dispose();
  };

  try {
    await host.init();
  } catch (err) {
    // A corrupt index.json (or any other restore failure) must not take the
    // whole extension down with it: the view provider is already registered
    // above, so the panel still comes up — with an empty roster — instead
    // of the extension failing to activate and there being no UI at all.
    console.error('[mar-code] failed to restore session index; starting with an empty roster', err);
  }
}

export async function deactivate() {
  await pendingDeactivate?.();
}

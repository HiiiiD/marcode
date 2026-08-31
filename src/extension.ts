import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentsMdNudgeController } from './host/agents-md-nudge';
import { AttachmentStore } from './host/attachment-store';
import { defaultCwdOf } from './host/default-cwd';
import { diffUri, registerDiffContentProvider } from './host/diff-content-provider';
import { EditorContextTracker } from './host/editor-context-tracker';
import { FleetPanel, FLEET_VIEW_TYPE } from './host/fleet-panel';
import { clampCap } from './host/fleet-diff';
import { PanelViewProvider } from './host/panel-view-provider';
import { PostBus } from './host/post-bus';
import type { AttachmentHost, ConfigHost } from './host/message-router';
import { PROFILE_GUARD_SNIPPET } from './host/profile-noise';
import { ReviewPanel, REVIEW_VIEW_TYPE } from './host/review-panel';
import { SelfControlMcpServer } from './host/self-control-mcp-server';
import { SessionManager } from './host/session-manager';
import { TranscriptStore } from './host/transcript-store';
import { createVscodeEditorSource } from './host/vscode-editor-source';
import { createWorkspaceFileIndex } from './host/workspace-file-index';
import { ExtractiveSummarizer } from './memory/extractive-summarizer';
import { FtsMemoryStore } from './memory/fts-memory-store';
import type { MemoryStore } from './memory/types';
import { ClaudeProvider } from './providers/claude/claude-provider';
import { CodexProvider } from './providers/codex/codex-provider';
import { FakeProvider } from './providers/fake/fake-provider';
import { OpenCodeProvider } from './providers/opencode/opencode-provider';
import type { DiffBase } from './protocol/messages';
import {
  DEFAULT_PROVIDER_IDS, ENABLED_PROVIDERS_SETTING, KNOWN_PROVIDER_IDS, PROVIDER_INSTANCES_SETTING,
} from './shared/settings';
import {
  claudeLoginCommand, codexLoginCommand, computeLoginKind, resolveEnvMap, validateProviderInstances,
} from './shared/provider-instances';
import type { AgentProvider, SelfControlMcpConfig } from './providers/types';

/**
 * `marcode.codex.path` defaults to `""` (see package.json) so the
 * settings UI shows an empty field, but CodexProvider's own default only
 * kicks in for `undefined` — passing through `""` would spawn `''` and
 * make Codex unavailable out of the box. Empty (or unset) means "use codex
 * from PATH", so it is normalized to `undefined` here at the boundary.
 */
function codexBinPath(): string | undefined {
  const configured = vscode.workspace.getConfiguration('marcode').get<string>('codex.path');
  return configured ? configured : undefined;
}

/**
 * `marcode.opencode.path` defaults to `""` (see package.json) so the
 * settings UI shows an empty field, but OpenCodeProvider's own default only
 * kicks in for `undefined` — passing through `""` would spawn `''` and
 * make OpenCode unavailable out of the box. Empty (or unset) means "use opencode
 * from PATH", so it is normalized to `undefined` here at the boundary.
 */
function openCodeBinPath(): string | undefined {
  const configured = vscode.workspace.getConfiguration('marcode').get<string>('opencode.path');
  return configured ? configured : undefined;
}

/**
 * `marcode.review.fileCap` — the default page size `SessionManager.fleetDiff`
 * asks for when a request omits its own `cap`. Sanitized through the same
 * `clampCap` `treeChanges` itself uses: a missing, non-numeric or non-positive
 * value falls back to `FILE_CAP` (500), and an over-large one clamps to
 * `MAX_FILE_CAP` (2000) rather than letting a typo ask the host to parse an
 * unbounded numstat every poll.
 */
function reviewFileCap(): number {
  const configured = vscode.workspace.getConfiguration('marcode').get<number>('review.fileCap');
  return clampCap(configured);
}

/**
 * `marcode.review.pollIntervalMs` — how often the review tab re-reads a
 * dirty working tree. Floored at 100ms so a misconfigured value cannot turn
 * this into a busy loop of git spawns; a non-number or non-positive value
 * falls back to the host's own 750ms default.
 */
function reviewPollIntervalMs(): number {
  const configured = vscode.workspace.getConfiguration('marcode').get<number>('review.pollIntervalMs');
  if (typeof configured !== 'number' || Number.isNaN(configured) || configured < 1) { return 750; }
  return Math.max(100, Math.floor(configured));
}

/**
 * `marcode.review.baseRefs` — extra candidate refs `resolveBase` tries for
 * a working tree whose integration branch (`develop`, `trunk`, …) is neither
 * auto-detected via `origin/HEAD` nor one of `fleet-diff.ts`'s own hardcoded
 * fallbacks. A malformed value (not an array of strings) is dropped rather
 * than passed through — a bad ref name here would name that fact in a diff
 * base line, not in the settings UI where it could be fixed.
 */
function reviewBaseRefs(): string[] {
  const configured = vscode.workspace.getConfiguration('marcode').get<unknown>('review.baseRefs');
  if (!Array.isArray(configured)) { return []; }
  return configured.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '');
}

/**
 * `marcode.favoriteModels` — model rows the New session dialog's user
 * starred, each keyed `"providerId modelId"` (see
 * `shared/model-catalog.ts#modelKey`). A malformed value (not an array of
 * strings) is dropped rather than passed through, the same posture as
 * `reviewBaseRefs`.
 */
function favoriteModels(): string[] {
  const configured = vscode.workspace.getConfiguration('marcode').get<unknown>('favoriteModels');
  if (!Array.isArray(configured)) { return []; }
  return configured.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
}

/**
 * The provider ids this window registers.
 *
 * A `Set` of ids rather than a filter over a provider list, because
 * construction itself is what is gated: `ClaudeProvider` and `CodexProvider`
 * each own a subprocess, and building one nobody enabled would spawn a CLI to
 * answer a question the panel will never ask.
 *
 * A malformed value (not an array, or entries that are not strings) falls back
 * to the default rather than yielding a panel with nothing in it: the user's
 * mistake is in a settings file, and a silently empty roster is a worse
 * account of it than the default behaviour plus an unknown-id warning.
 */
function enabledProviderIds(): Set<string> {
  const configured = vscode.workspace
    .getConfiguration()
    .get<unknown>(ENABLED_PROVIDERS_SETTING);
  if (!Array.isArray(configured) || configured.some((id) => typeof id !== 'string')) {
    if (configured !== undefined) {
      console.warn('[mar-code] enabledProviders is not a list of strings; using the default', configured);
    }
    return new Set(DEFAULT_PROVIDER_IDS);
  }
  const ids = configured as string[];
  const unknown = ids.filter((id) => !KNOWN_PROVIDER_IDS.includes(id as typeof KNOWN_PROVIDER_IDS[number]));
  if (unknown.length > 0) {
    // Named, not silently dropped: an id with a typo in it is the difference
    // between "Claude is broken" and "Claude was never asked", and the panel's
    // empty state cannot tell that story — it only ever hears about providers
    // that exist.
    void vscode.window.showWarningMessage(
      `${ENABLED_PROVIDERS_SETTING}: ignoring unknown provider ${unknown.join(', ')}. `
        + `Known providers: ${KNOWN_PROVIDER_IDS.join(', ')}.`,
    );
  }
  return new Set(ids);
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
  const rootDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
  const store = new TranscriptStore(rootDir);
  const attachments = new AttachmentStore(rootDir);
  // Errors are state, never exceptions — same posture as
  // `selfControlServer.start()` below. A locked/corrupt `memory.sqlite`, or
  // `node:sqlite`/FTS5 being unavailable in this Electron-bundled Node, must
  // not fail the whole extension: `SessionManager` and `SelfControlMcpServer`
  // both already accept `memory` as optional, and their `marcode__recall`
  // tools already answer gracefully with none configured.
  let memory: MemoryStore | undefined;
  try {
    memory = new FtsMemoryStore(
      path.join(rootDir, 'memory.sqlite'),
      new ExtractiveSummarizer(),
      { tail: (id, limit) => store.tail(id, limit) },
    );
  } catch (err) {
    console.warn('[mar-code] memory store unavailable; recall tools will be disabled', err);
  }

  // Order matters: SessionPicker uses state.catalog[0] for the New button,
  // so Claude — the real provider — is registered first.
  //
  // Registration is gated on `marcode.enabledProviders`, and a disabled
  // provider is not registered at all rather than registered-and-hidden: it
  // must appear in neither `catalog()` nor `unavailable()`, since "nobody
  // asked for this backend" is not a diagnosis of it. Emptying the setting is
  // therefore how the no-provider empty state is reached on purpose.
  const enabled = enabledProviderIds();
  // Empty at construction — `manager` needs this Map to build, but the
  // self-control server (constructed just below, from `manager`) needs to
  // resolve its config before providers can be built with it. `.set()` below
  // populates the same Map by reference: `SessionManager` reads
  // `this.providers` live on every call (`catalog()`, `create()`), never
  // copies it at construction, so populating it after is safe.
  const providers = new Map<string, AgentProvider>();

  let provider: PanelViewProvider;
  const bus = new PostBus();
  const manager = new SessionManager(
    store, providers, (msg) => bus.post(msg), undefined, warnAboutProfile, attachments,
    reviewFileCap(), reviewBaseRefs(), memory,
  );

  // Constructed against `manager` via closures — `SessionManagerLike`
  // defers to `manager` only when a tool call actually arrives, well after
  // `activate()` returns, the same "assigned below, before this ever runs"
  // pattern `agentsMdNudge`'s `post` callback uses further down.
  const selfControlServer = new SelfControlMcpServer({
    catalog: () => manager.catalog(),
    create: (providerId, cwd, model, effort, mode) => manager.create(providerId, cwd, model, effort, mode),
  }, memory);
  let selfControlConfig: SelfControlMcpConfig | undefined;
  try {
    selfControlConfig = await selfControlServer.start();
  } catch (err) {
    // Errors are state, never exceptions, and sessions from this launch
    // simply have no self-control tool — the same posture a failed model
    // probe takes.
    console.warn('[mar-code] self-control MCP server failed to start; spawn_session will be unavailable', err);
  }

  if (enabled.has('claude')) { providers.set('claude', new ClaudeProvider(undefined, selfControlConfig)); }
  // Constructed only when enabled — it owns a CLI subprocess, and building
  // one nobody asked for would spawn a backend to answer a question the panel
  // never puts to it. `undefined` is why the path listener below is guarded.
  const codexProvider = enabled.has('codex')
    ? new CodexProvider({ binPath: codexBinPath(), selfControlMcp: selfControlConfig })
    : undefined;
  if (codexProvider) { providers.set('codex', codexProvider); }
  // Constructed only when enabled — it owns a CLI subprocess, and building
  // one nobody asked for would spawn a backend to answer a question the panel
  // never puts to it. `undefined` is why the path listener below is guarded.
  const openCodeProvider = enabled.has('opencode')
    ? new OpenCodeProvider({ binPath: openCodeBinPath(), selfControlMcp: selfControlConfig })
    : undefined;
  if (openCodeProvider) { providers.set('opencode', openCodeProvider); }
  if (enabled.has('fake')) { providers.set('fake', new FakeProvider(
    (text) => (text.includes('rm')
      ? [{
          kind: 'permission', id: `p-${Date.now()}`,
          tool: { kind: 'command', label: 'Bash', command: text },
        }]
      : [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]),
    // Scripted so both the context ring and the usage strip have something
    // to render in the dev host. Obviously synthetic, and deliberately
    // scripted *here* rather than defaulted inside FakeProvider — the unit
    // tests depend on an unscripted fake genuinely omitting `contextBreakdown`.
    // The two memory files share a basename on purpose: that is the case
    // the popover's rows have to stay distinguishable in.
    {
      context: {
        systemPercent: 12,
        memoryPercent: 5,
        conversationPercent: 26,
        freePercent: 57,
        memoryFiles: [
          { path: '/fake/workspace/CLAUDE.md', percent: 4 },
          { path: '/fake/home/.claude/CLAUDE.md', percent: 1 },
        ],
      },
      windows: [
        { id: 'five-hour', label: 'Session (5h)', usedPercent: 62, resetsAt: Date.now() + 2 * 3_600_000 },
        { id: 'seven-day', label: 'Week', usedPercent: 18, resetsAt: Date.now() + 3 * 86_400_000 },
      ],
    },
  )); }

  /** One instance id -> the terminal command that signs it in, and the env that terminal runs with. */
  type LoginRecipe = { terminalName: string; command: string; env: NodeJS.ProcessEnv };
  const loginRecipes = new Map<string, LoginRecipe>();
  if (enabled.has('claude')) {
    loginRecipes.set('claude', { terminalName: 'Claude login', command: 'claude auth login', env: process.env });
  }
  if (codexProvider) {
    loginRecipes.set('codex', { terminalName: 'Codex login', command: 'codex login', env: process.env });
  }

  // Extra named instances of an existing kind — additive to `enabled` above.
  // See docs/superpowers/specs/2026-08-31-provider-instances-design.md.
  const { valid: instanceConfigs, warnings: instanceWarnings } = validateProviderInstances(
    vscode.workspace.getConfiguration().get<unknown>(PROVIDER_INSTANCES_SETTING),
    [...providers.keys()],
  );
  for (const warning of instanceWarnings) {
    void vscode.window.showWarningMessage(warning);
  }
  for (const cfg of instanceConfigs) {
    const resolvedEnv = resolveEnvMap(cfg.envMap, process.env);
    const mergedEnv = { ...process.env, ...resolvedEnv };
    const loginKind = computeLoginKind(cfg.kind, resolvedEnv);
    if (cfg.kind === 'claude') {
      providers.set(cfg.id, new ClaudeProvider(undefined, selfControlConfig, {
        id: cfg.id, displayName: cfg.displayName, env: mergedEnv,
        pathToClaudeCodeExecutable: cfg.binPath, loginKind,
      }));
      if (loginKind === 'oauth') {
        loginRecipes.set(cfg.id, {
          terminalName: `${cfg.displayName} login`,
          command: claudeLoginCommand(cfg.binPath),
          env: mergedEnv,
        });
      }
    } else if (cfg.kind === 'codex') {
      providers.set(cfg.id, new CodexProvider({
        id: cfg.id, displayName: cfg.displayName, binPath: cfg.binPath,
        env: mergedEnv, selfControlMcp: selfControlConfig, loginKind,
      }));
      loginRecipes.set(cfg.id, {
        terminalName: `${cfg.displayName} login`,
        command: codexLoginCommand(cfg.binPath, resolvedEnv),
        env: mergedEnv,
      });
    } else {
      providers.set(cfg.id, new OpenCodeProvider({
        id: cfg.id, displayName: cfg.displayName, binPath: cfg.binPath,
        env: mergedEnv, selfControlMcp: selfControlConfig,
      }));
    }
  }

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

  const editorHost = {
    current: () => tracker.current,
    reveal: (target: string, startLine?: number) => {
      void revealFile(target, startLine);
    },
    openDiff: (root: string, target: string, base: DiffBase) => {
      void openFileDiff(root, target, base);
    },
    openSettings: (section: string) => {
      void vscode.commands.executeCommand('workbench.action.openSettings', section);
    },
    openExternal: (url: string) => {
      void openExternal(url);
    },
    exportCsv: (csv: string) => {
      void exportCsv(csv);
    },
    login: (providerId: string) => {
      // `providerId` names a registered instance's login recipe — a provider
      // with none (no login flow, e.g. a key-based instance, or a typo
      // reaching this from a future provider) is a no-op rather than a thrown
      // error, the same tolerance `revealFile` and `openFileDiff` give a dead
      // reference.
      const recipe = loginRecipes.get(providerId);
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    },
  };

  const configHost: ConfigHost = {
    setFavoriteModels: (ids) => {
      void vscode.workspace.getConfiguration('marcode')
        .update('favoriteModels', ids, vscode.ConfigurationTarget.Global);
    },
  };

  const picker: AttachmentHost = {
    pick: async () => {
      const chosen = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
      });
      return chosen?.map((uri) => uri.fsPath) ?? [];
    },
  };

  const review = new ReviewPanel(
    context.extensionUri, manager, bus, defaultCwd, editorHost, reviewPollIntervalMs(),
  );
  const fleet = new FleetPanel(context.extensionUri, manager, bus, defaultCwd, editorHost);

  const fileIndex = createWorkspaceFileIndex(defaultCwd);

  const agentsMdNudge = new AgentsMdNudgeController({
    findRelativePaths: async () => {
      const uris = await vscode.workspace.findFiles(
        '**/{CLAUDE.md,AGENTS.md}',
        '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}',
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
    favoriteModels,
    configHost,
  );
  // The sidebar is the client that wants everything. Registered here rather
  // than inside PanelViewProvider so there is one place that says which
  // surfaces exist and what each of them sees.
  bus.add({ post: (msg) => provider.post(msg), wants: () => true });

  // Push every change to the webview so the composer chip tracks the editor.
  const contextSub = tracker.onChange((ctx) => provider.post({ t: 'editor-context', ctx }));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PanelViewProvider.viewType, provider),
    registerDiffContentProvider(),
    { dispose: () => { void manager.dispose(); } },
    { dispose: () => { void selfControlServer.dispose(); } },
    { dispose: () => { contextSub.dispose(); tracker.dispose(); editorSource.dispose(); } },
    fileIndex,
    vscode.commands.registerCommand('marcode.review.open', () => { review.open(); }),
    vscode.commands.registerCommand('marcode.fleet.open', () => { fleet.open(); }),
    // Without a serializer VS Code restores the tab as a blank webview, which
    // is worse than not restoring it. The host owns whether the tab exists;
    // the client owns nothing durable, so re-attaching is the whole job.
    vscode.window.registerWebviewPanelSerializer(REVIEW_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { review.restore(panel); },
    }),
    vscode.window.registerWebviewPanelSerializer(FLEET_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => { fleet.restore(panel); },
    }),
    { dispose: () => { review.dispose(); } },
    { dispose: () => { fleet.dispose(); } },
    vscode.commands.registerCommand('marcode.codex.login', () => {
      const recipe = loginRecipes.get('codex');
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    }),
    vscode.commands.registerCommand('marcode.claude.login', () => {
      const recipe = loginRecipes.get('claude');
      if (recipe) { openLoginTerminal(recipe.terminalName, recipe.command, recipe.env); }
    }),
    // A changed path is a different install: point the provider at it, then
    // re-probe — which is also how the provider recovers from 'unavailable'.
    // refreshModels already IS the availability probe — see session-manager.
    // setBinPath must run first: it is what makes the re-probe actually use
    // the new path, rather than retrying the stale one connect() already
    // cached. It also kills the process running against the old binary,
    // which ends any Codex session currently in flight — a user who
    // changes the binary has declared the running one wrong, so those
    // sessions land in 'error' with a transcript item (CodexRun's onClose
    // handling), not silently on the old process.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (codexProvider && e.affectsConfiguration('marcode.codex.path')) {
        codexProvider.setBinPath(codexBinPath());
        void manager.refreshModels(defaultCwd);
      }
      // Registration happens once, at activate, and a provider added here
      // would have no sessions, no transcript store wiring and no probe —
      // so this asks rather than pretends. A re-probe would be the wrong
      // remedy: the provider set itself changed, not any backend's answer.
      if (e.affectsConfiguration(ENABLED_PROVIDERS_SETTING)) {
        const reload = 'Reload window';
        void vscode.window.showInformationMessage(
          'The enabled agent providers changed. Reload the window to apply it.',
          reload,
        ).then((choice) => {
          if (choice !== reload) { return; }
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      }
      if (e.affectsConfiguration(PROVIDER_INSTANCES_SETTING)) {
        const reload = 'Reload window';
        void vscode.window.showInformationMessage(
          'Provider instances changed. Reload the window to apply it.',
          reload,
        ).then((choice) => {
          if (choice !== reload) { return; }
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
      }
    }),
  );

  pendingDeactivate = async () => {
    await manager.dispose();
    await selfControlServer.dispose();
  };

  try {
    await manager.init();
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

/**
 * Opens the file behind a transcript chip. `target` is whatever the chip
 * carried: workspace-relative for files inside an open folder, absolute
 * otherwise. An absolute path is opened directly. A relative path does not
 * record which workspace root it came from, so it is resolved by trying
 * each root in turn and opening the first one where the file actually
 * exists (checked cheaply with `vscode.workspace.fs.stat`) — this avoids
 * silently opening a same-named file under the wrong root in a multi-root
 * workspace. Falls back to the first root if the file exists under none of
 * them, so the error path below still gets a sensible URI to report.
 */
async function revealFile(target: string, startLine?: number): Promise<void> {
  try {
    const roots = vscode.workspace.workspaceFolders ?? [];
    const uri = path.isAbsolute(target)
      ? vscode.Uri.file(target)
      : await resolveRelativeTarget(target, roots);
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.max(0, (startLine ?? 1) - 1);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(line, 0, line, 0),
    });
  } catch (err) {
    // A chip can outlive the file it points at (renamed, deleted, or from a
    // transcript restored in a different workspace). Failing to open one is
    // not worth a user-facing error.
    console.error('[mar-code] could not reveal', target, err);
  }
}

/**
 * Opens one file's change in VS Code's own diff editor.
 *
 * The panel lists; VS Code renders. A side-by-side, syntax-highlit,
 * navigable diff already exists in this window, and reimplementing a worse
 * one inside a 300px sidebar would be the wrong half of the job.
 */
async function openFileDiff(root: string, target: string, base: DiffBase): Promise<void> {
  try {
    const right = vscode.Uri.file(path.join(root, target));
    const left = diffUri(root, target, base.kind === 'merge-base' ? base.sha : 'HEAD');
    const label = base.kind === 'merge-base' ? base.ref : 'HEAD';
    await vscode.commands.executeCommand(
      'vscode.diff', left, right, `${target} (${label} → working tree)`,
    );
  } catch (err) {
    // A row can outlive the file it names — reverted, deleted, or swept with
    // its worktree. Failing to open one is not worth a user-facing error, the
    // same call this file already makes for a dead transcript chip.
    console.error('[mar-code] could not open diff for', target, err);
  }
}

/**
 * `claude auth login` / `codex login` (or their instance-scoped variants)
 * each open a browser flow and need a real TTY, so this hands the user a
 * terminal rather than trying to drive it. Re-probing afterward is the
 * existing "Check again" retry — nothing here waits for the terminal to
 * close or the login to succeed. `env`, when given, is what scopes the
 * session to a custom instance's own `CLAUDE_CONFIG_DIR`/`CODEX_HOME` rather
 * than the default one.
 */
function openLoginTerminal(terminalName: string, command: string, env?: NodeJS.ProcessEnv): void {
  const terminal = vscode.window.createTerminal({ name: terminalName, ...(env ? { env } : {}) });
  terminal.show();
  terminal.sendText(command);
}

/**
 * Hands a URL from agent output to the OS.
 *
 * `Uri.parse` is strict so a malformed href fails here, in a `catch` that
 * logs, rather than reaching `openExternal` as a half-parsed URI. VS Code
 * owns the decision after that — an unfamiliar host gets its own
 * trusted-domain prompt, which is a gate this panel should not duplicate.
 */
async function openExternal(url: string): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  } catch (err) {
    // Errors are state, never exceptions, and a link that will not open is
    // not worth a modal — the same call the reveal path already makes.
    console.error('[mar-code] could not open', url, err);
  }
}

/**
 * Saves a markdown table's CSV text to a file the user picks. A cancelled
 * dialog resolves `undefined`, which is not an error — it's the user
 * changing their mind, so it takes no action rather than a swallowed catch.
 */
async function exportCsv(csv: string): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    filters: { 'CSV': ['csv'] },
    defaultUri: vscode.Uri.file('table.csv'),
  });
  if (!target) { return; }
  try {
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(csv));
  } catch (err) {
    // Errors are state, never exceptions — same posture as openExternal.
    console.error('[mar-code] could not save', target.fsPath, err);
    void vscode.window.showErrorMessage(`Could not save ${target.fsPath}.`);
  }
}

async function resolveRelativeTarget(
  target: string, roots: readonly vscode.WorkspaceFolder[],
): Promise<vscode.Uri> {
  if (roots.length === 0) { return vscode.Uri.file(target); }
  for (const root of roots) {
    const candidate = vscode.Uri.joinPath(root.uri, target);
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // Not under this root — try the next one.
    }
  }
  // None of the roots have this file (renamed, deleted, or a transcript
  // restored in a different workspace); fall back to the first root so
  // openTextDocument fails with a normal "file not found" that the caller
  // logs, rather than this function throwing early.
  return vscode.Uri.joinPath(roots[0].uri, target);
}

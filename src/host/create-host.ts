import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FtsMemoryStore } from '../memory/fts/fts-memory-store';
import type { MemoryStore } from '../memory/types';
import type { HostToWebview, SessionId } from '../protocol/messages';
import { ClaudeProvider } from '../providers/claude/claude-provider';
import { CodexProvider } from '../providers/codex/codex-provider';
import { FakeProvider } from '../providers/fake/fake-provider';
import { OpenCodeProvider } from '../providers/opencode/opencode-provider';
import type { AgentProvider, SelfControlMcpConfig } from '../providers/types';
import { validateSummarizer, type SummarizerTarget } from '../shared/memory-settings';
import {
  claudeLoginCommand, codexLoginCommand, computeLoginKind, resolveEnvMap, validateProviderInstances,
} from '../shared/provider-instances';
import type { ProviderInstanceKind } from '../shared/provider-instances';
import { KNOWN_PROVIDER_IDS } from '../shared/settings';
import { validateSystemPrompts } from '../shared/system-prompts';
import { AccountCache } from './account-cache/account-cache';
import { seedFromWorkspaces } from './account-cache/seed-from-workspaces';
import { AttachmentStore } from './attachment-store';
import { ProjectResolver } from './project/project-resolver';
import { SyncService } from './sync/sync-service';
import { MemoryPublisher } from './sync/memory-publisher';
import { SyncEngine } from './sync/sync-engine';
import { readCredentials } from '../sync/credentials';
import { SyncState } from '../sync/sync-state';
import { RemoteMemory } from '../memory/remote-memory';

/**
 * The machine-wide sync stores under `<home>/sync/`. The writer is only ever written by the engine
 * that holds the lease; its DDL is idempotent, so a host that never holds it does no harm opening it.
 */
function openMemorySync(home: string): { state: SyncState; reader: RemoteMemory; writer: RemoteMemory; close(): void } | undefined {
  try {
    const dir = path.join(home, 'sync');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const state = new SyncState(path.join(dir, 'state.sqlite'));
    const file = path.join(dir, 'remote-memory.sqlite');
    const writer = new RemoteMemory(file);
    const reader = new RemoteMemory(file, { readOnly: true });
    return { state, reader, writer, close: () => { reader.close(); writer.close(); state.close(); } };
  } catch (err) {
    console.warn('[mar-code] sync: memory sync unavailable', err);
    return undefined;
  }
}
import { configPath } from './config-file';
import { FallbackSummarizer } from './digest/fallback-summarizer';
import { LlmSummarizer } from './digest/llm-summarizer';
import { focusSession } from './focus-session';
import type { HostConfig } from './host-config';
import { SelfControlMcpServer, type SessionManagerLike } from './self-control-mcp-server';
import { SessionManager } from './session-manager';
import { SessionOwnership } from './session-ownership';
import { TranscriptStore } from './transcript-store';

export interface LoginRecipe { terminalName: string; command: string; env: NodeJS.ProcessEnv }

export interface CreateHostOptions {
  workspaceDir: string;
  config: HostConfig;
  hostKind: 'vscode' | 'tui' | 'daemon';
  workspaceRoots: () => string[];
  emit: (msg: HostToWebview) => void;
  notify: { warn(message: string): void };
  onShellNoise?: (profile: string) => void;
  /** Poll interval for roster sync and foreign-session tails; tests shrink it. */
  pollMs?: number;
  /** The Marcode home; holds the machine-wide `account.sqlite`. Absent means no shared cache. */
  marcodeHome?: string;
}

export interface HostHandle {
  manager: SessionManager;
  store: TranscriptStore;
  attachments: AttachmentStore;
  providers: Map<string, AgentProvider>;
  enabled: Set<string>;
  loginRecipes: Map<string, LoginRecipe>;
  selfControlServer: SelfControlMcpServer;
  /** The store recall reads (local, sibling workspaces, other devices); absent when memory is off. */
  memory?: MemoryStore;
  init(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createHost(opts: CreateHostOptions): Promise<HostHandle> {
  const { config, notify } = opts;
  const store = new TranscriptStore(opts.workspaceDir, opts.hostKind);
  const attachments = new AttachmentStore(opts.workspaceDir);
  // Errors are state, never exceptions: a locked/corrupt `memory.sqlite`, or
  // `node:sqlite`/FTS5 being unavailable, must not fail the host. `SessionManager`
  // and `SelfControlMcpServer` both accept `memory` as optional.
  let memory: MemoryStore | undefined;
  let fts: FtsMemoryStore | undefined;
  let closeMemory: (() => void) | undefined;
  const syncCreds = config.memory.enabled && opts.marcodeHome ? await readCredentials(opts.marcodeHome) : undefined;
  const memorySync = syncCreds && opts.marcodeHome ? openMemorySync(opts.marcodeHome) : undefined;
  if (config.memory.enabled) {
    try {
      // require, not import(): evaluated here so a missing node:sqlite lands in the catch, and it resolves extensionless under tsx, esbuild and bun alike
      const { FtsMemoryStore } = require('../memory/fts/fts-memory-store') as typeof import('../memory/fts/fts-memory-store');
      fts = new FtsMemoryStore(
        path.join(opts.workspaceDir, 'memory.sqlite'),
        { tail: (id, limit) => store.tail(id, limit) },
      );
      memory = fts;
      closeMemory = () => fts?.close();
      try {
        const { ProjectMemory } = require('../memory/project-memory') as typeof import('../memory/project-memory');
        const shared = new ProjectMemory(fts, opts.workspaceDir, memorySync ? { remote: memorySync.reader } : {});
        memory = shared;
        closeMemory = () => shared.close();
      } catch (err) {
        console.warn('[mar-code] shared project memory unavailable; recall stays in this workspace', err);
      }
    } catch (err) {
      console.warn('[mar-code] memory store unavailable; recall tools will be disabled', err);
      notify.warn(`Marcode memory is unavailable (${(err as Error).message}); recall and session digests are off in this window.`);
    }
  }

  // A disabled provider is not registered at all rather than registered-and-hidden:
  // it must appear in neither `catalog()` nor `unavailable()`.
  const enabled = new Set(config.enabledProviders);
  // Empty at construction: `manager` needs this Map to build, and the self-control
  // server needs to resolve its config before providers can be built with it.
  // `SessionManager` reads `this.providers` live, so populating it after is safe.
  const providers = new Map<string, AgentProvider>();

  const projects = new ProjectResolver(config.projects.overrides);
  // Every host publishes its own sessions into the machine-wide outbox; the lease decides which one pushes it.
  let manager!: SessionManager;
  const publisher = memorySync && memory ? new MemoryPublisher({
    inner: memory, state: memorySync.state, excluded: config.sync.excludeProjects,
    relCwd: async (cwd) => {
      const root = (await projects.resolve(cwd))?.root;
      return root ? path.relative(root, cwd).split(path.sep).join('/') || '.' : '.';
    },
    transcript: async (id) => (await store.tail(id, Number.MAX_SAFE_INTEGER)).items,
    sessions: () => manager.publishableSessions(),
  }) : undefined;
  if (publisher) { memory = publisher; }
  manager = new SessionManager(
    store, providers, opts.emit, undefined, opts.onShellNoise, attachments,
    config.review.fileCap, config.review.baseRefs, memory, undefined, config.usageMirrors,
    undefined, projects,
  );
  const ownership = new SessionOwnership(path.join(opts.workspaceDir, 'sessions'), opts.hostKind);
  manager.setOwnership(ownership, { tailIntervalMs: opts.pollMs });
  manager.setShellAliases(config.shell.aliases);
  const accountCache = opts.marcodeHome ? AccountCache.open(path.join(opts.marcodeHome, 'account.sqlite')) : undefined;
  if (accountCache) { manager.setAccountCache(accountCache, { pollMs: opts.pollMs }); }
  const sync = opts.marcodeHome
    ? new SyncService({
      home: opts.marcodeHome, configFile: configPath(opts.marcodeHome), roots: opts.workspaceRoots,
      overrides: config.projects.overrides, resolve: (cwd) => projects.resolve(cwd), broadcast: opts.emit,
    })
    : undefined;
  if (sync) {
    manager.setSyncService(sync);
    sync.start();
  }
  const engine = memorySync && opts.marcodeHome
    ? new SyncEngine({ home: opts.marcodeHome, hostKind: opts.hostKind, state: memorySync.state, remote: memorySync.writer })
    : undefined;
  engine?.start();

  // `satisfies Required<...>`: every optional member must be wired here, or the build fails.
  const selfControlManager = {
    catalog: () => manager.catalog(),
    create: (providerId, cwd, model, effort, mode, worktree, includeEditorContext) =>
      manager.create(providerId, cwd, model, effort, mode, worktree, includeEditorContext),
    setVisible: (ids) => manager.setVisible(ids as SessionId[]),
    reveal: (id) => focusSession(manager, id as SessionId, config.layout.autoGrid ? manager.autoGrid() : undefined),
    summaries: (opts) => manager.summaries(opts),
    lookup: (id) => manager.lookup(id as SessionId),
    subagents: manager.subagents,
    isForeign: (id) => manager.isForeign(id as SessionId),
    visibleIds: () => manager.visibleIds(),
    // `summaries()` spans every session, including one restored from disk that no
    // pane has opened this launch; `open()` materializes it. An unknown id becomes
    // `undefined` rather than a rejection.
    get: async (id) => {
      try {
        return await manager.open(id as SessionId);
      } catch {
        return undefined;
      }
    },
    transcriptTail: (id, limit) => manager.transcriptTail(id as SessionId, limit),
    close: (id) => manager.close(id as SessionId),
    contextBreakdown: (id) => manager.contextBreakdown(id as SessionId),
    handoffSummary: (id) => manager.handoffSummary(id as SessionId),
    usageSnapshot: () => manager.usageSnapshot(),
    usageDisplayNames: () => manager.usageDisplayNames(),
    refreshUsage: (cwd) => manager.refreshUsage(cwd),
    recallScope: (id) => manager.recallScopeOfSession(id as SessionId),
  } satisfies Required<SessionManagerLike>;
  const selfControlServer = new SelfControlMcpServer(selfControlManager, memory, config.spawn.preference);
  manager.setWorkspaceRoots(opts.workspaceRoots);
  let selfControlConfig: SelfControlMcpConfig | undefined;
  try {
    selfControlConfig = await selfControlServer.start();
  } catch (err) {
    console.warn('[mar-code] self-control MCP server failed to start; spawn_session will be unavailable', err);
  }

  // Validated ahead of every provider construction: `systemPrompts` needs every
  // id's kind up front.
  const { valid: instanceConfigs, warnings: instanceWarnings } = validateProviderInstances(
    config.providerInstances, KNOWN_PROVIDER_IDS,
  );
  for (const warning of instanceWarnings) { notify.warn(warning); }
  const kindOf: Record<string, ProviderInstanceKind> = { claude: 'claude', codex: 'codex', opencode: 'opencode' };
  for (const cfg of instanceConfigs) { kindOf[cfg.id] = cfg.kind; }
  const { prompts: systemPrompts, warnings: systemPromptWarnings } = validateSystemPrompts(config.systemPrompts, kindOf);
  for (const warning of systemPromptWarnings) { notify.warn(warning); }

  if (enabled.has('claude')) {
    providers.set('claude', new ClaudeProvider(undefined, selfControlConfig, {
      systemPrompt: systemPrompts.claude, claudeAiConnectors: config.claude.claudeAiConnectors,
    }));
  }
  const codexProvider = enabled.has('codex')
    ? new CodexProvider({ binPath: config.codexPath, selfControlMcp: selfControlConfig, systemPrompt: systemPrompts.codex as string | undefined })
    : undefined;
  if (codexProvider) { providers.set('codex', codexProvider); }
  const openCodeProvider = enabled.has('opencode')
    ? new OpenCodeProvider({ binPath: config.opencodePath, selfControlMcp: selfControlConfig })
    : undefined;
  if (openCodeProvider) { providers.set('opencode', openCodeProvider); }
  if (enabled.has('fake')) { providers.set('fake', new FakeProvider(
    (text) => (text.includes('permission fixture')
      ? [{
          kind: 'permission', id: `p-${Date.now()}`,
          tool: {
            kind: 'other', label: 'Read',
            raw: {
              filepath: '/fake/workspace/src/example.ts', parentDir: '/fake/workspace/src',
              encoding: 'utf8', maxBytes: 4096, followSymlinks: false,
            },
          },
        }]
      : text.includes('rm')
      ? [{
          kind: 'permission', id: `p-${Date.now()}`,
          tool: { kind: 'command', label: 'Bash', command: text },
        }]
      : [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }]),
    // Scripted so both the context ring and the usage strip have something to
    // render in the dev host. The two memory files share a basename on purpose:
    // that is the case the popover's rows have to stay distinguishable in.
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
  const loginRecipes = new Map<string, LoginRecipe>();
  if (enabled.has('claude')) {
    loginRecipes.set('claude', { terminalName: 'Claude login', command: 'claude auth login', env: process.env });
  }
  if (codexProvider) {
    loginRecipes.set('codex', { terminalName: 'Codex login', command: 'codex login', env: process.env });
  }

  for (const cfg of instanceConfigs) {
    const resolvedEnv = resolveEnvMap(cfg.envMap, process.env);
    // resolveEnvMap silently omits any subprocess var whose named OS var is unset;
    // proceeding with no signal would leave the instance running as the default account.
    for (const entry of Object.values(cfg.envMap ?? {})) {
      if (entry.type === 'env' && process.env[entry.value] === undefined) {
        notify.warn(`Provider instance "${cfg.id}": OS environment variable "${entry.value}" is not set.`);
      }
    }
    const mergedEnv = { ...process.env, ...resolvedEnv };
    const loginKind = computeLoginKind(cfg.kind, resolvedEnv);
    if (cfg.kind === 'claude') {
      providers.set(cfg.id, new ClaudeProvider(undefined, selfControlConfig, {
        id: cfg.id, displayName: cfg.displayName, env: mergedEnv,
        pathToClaudeCodeExecutable: cfg.binPath, loginKind, systemPrompt: systemPrompts[cfg.id],
        claudeAiConnectors: config.claude.claudeAiConnectors,
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
        systemPrompt: systemPrompts[cfg.id] as string | undefined,
      }));
      loginRecipes.set(cfg.id, {
        terminalName: `${cfg.displayName} login`,
        command: codexLoginCommand(cfg.binPath, resolvedEnv),
        env: mergedEnv,
      });
    } else {
      providers.set(cfg.id, new OpenCodeProvider({
        id: cfg.id, displayName: cfg.displayName, binPath: cfg.binPath,
        env: mergedEnv, selfControlMcp: selfControlConfig, loginKind,
      }));
    }
    const instance = providers.get(cfg.id);
    if (instance) { instance.kind = cfg.kind; }
    if (instance && cfg.icon) { instance.icon = { text: cfg.icon, ...(cfg.color ? { color: cfg.color } : {}) }; }
  }

  // Extractive digests are idempotent so both hosts write them; only the LLM summarizer costs money, so one host runs it.
  const digestLock = new SessionOwnership(opts.workspaceDir, opts.hostKind);
  let holdsDigest = false;
  if (memory) {
    try {
      holdsDigest = (await digestLock.claim('digest')).owned;
    } catch (err) {
      notify.warn(`Marcode could not claim the memory summarizer lock (${(err as Error).message}); sessions are summarized without a model in this window.`);
    }
  }
  if (memory && holdsDigest) {
    // Validated against every registered id, instances included, so a provider named here that is
    // not actually enabled degrades to "off" with one warning instead of failing per session.
    const { setting, warnings } = validateSummarizer(config.memory.summarizer, providers.keys());
    for (const warning of warnings) { notify.warn(warning); }
    if (setting.mode === 'llm') {
      const llm = (t: SummarizerTarget, concurrency?: number) => new LlmSummarizer({
        prompt: setting.prompt,
        provider: providers.get(t.provider) as AgentProvider,
        model: t.model,
        effort: t.effort,
        concurrency,
        cwd: os.tmpdir(),
      });
      const chain = [llm(setting, setting.concurrency), ...setting.fallbacks.map((f) => llm(f))];
      manager.setSummarizer(chain.length === 1 ? chain[0] : new FallbackSummarizer(chain));
    }
  }

  return {
    manager, store, attachments, providers, enabled, loginRecipes, selfControlServer, memory,
    init: async () => {
      if (accountCache && opts.marcodeHome) {
        await seedFromWorkspaces(accountCache, path.join(opts.marcodeHome, 'workspaces'));
      }
      await manager.init();
      void publisher?.backfill().catch((err: unknown) => { console.error('[mar-code] sync: backfill failed', err); });
      manager.startRosterSync(opts.pollMs);
    },
    dispose: async () => {
      await manager.dispose();
      accountCache?.close();
      sync?.dispose();
      await engine?.dispose();
      memorySync?.close();
      await selfControlServer.dispose();
      await digestLock.dispose();
      closeMemory?.();
    },
  };
}

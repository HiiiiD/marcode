import * as os from 'node:os';
import * as path from 'node:path';
import type { FtsMemoryStore } from '../memory/fts-memory-store';
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
import { AttachmentStore } from './attachment-store';
import { FallbackSummarizer } from './digest/fallback-summarizer';
import { LlmSummarizer } from './digest/llm-summarizer';
import type { HostConfig } from './host-config';
import { SelfControlMcpServer } from './self-control-mcp-server';
import { SessionManager } from './session-manager';
import { SessionOwnership } from './session-ownership';
import { TranscriptStore } from './transcript-store';

export interface LoginRecipe { terminalName: string; command: string; env: NodeJS.ProcessEnv }

export interface CreateHostOptions {
  workspaceDir: string;
  config: HostConfig;
  hostKind: 'vscode' | 'tui';
  workspaceRoots: () => string[];
  emit: (msg: HostToWebview) => void;
  notify: { warn(message: string): void };
  onShellNoise?: (profile: string) => void;
  /** Poll interval for roster sync and foreign-session tails; tests shrink it. */
  pollMs?: number;
}

export interface HostHandle {
  manager: SessionManager;
  store: TranscriptStore;
  attachments: AttachmentStore;
  providers: Map<string, AgentProvider>;
  enabled: Set<string>;
  loginRecipes: Map<string, LoginRecipe>;
  selfControlServer: SelfControlMcpServer;
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
  if (config.memory.enabled) {
    try {
      // require, not import(): evaluated here so a missing node:sqlite lands in the catch, and it resolves extensionless under tsx, esbuild and bun alike
      const { FtsMemoryStore } = require('../memory/fts-memory-store') as typeof import('../memory/fts-memory-store');
      fts = new FtsMemoryStore(
        path.join(opts.workspaceDir, 'memory.sqlite'),
        { tail: (id, limit) => store.tail(id, limit) },
      );
      memory = fts;
    } catch (err) {
      console.warn('[mar-code] memory store unavailable; recall tools will be disabled', err);
    }
  }

  // A disabled provider is not registered at all rather than registered-and-hidden:
  // it must appear in neither `catalog()` nor `unavailable()`.
  const enabled = new Set(config.enabledProviders);
  // Empty at construction: `manager` needs this Map to build, and the self-control
  // server needs to resolve its config before providers can be built with it.
  // `SessionManager` reads `this.providers` live, so populating it after is safe.
  const providers = new Map<string, AgentProvider>();

  const manager = new SessionManager(
    store, providers, opts.emit, undefined, opts.onShellNoise, attachments,
    config.review.fileCap, config.review.baseRefs, memory, undefined, config.usageMirrors,
  );
  const ownership = new SessionOwnership(path.join(opts.workspaceDir, 'sessions'), opts.hostKind);
  manager.setOwnership(ownership, { tailIntervalMs: opts.pollMs });

  const selfControlServer = new SelfControlMcpServer({
    catalog: () => manager.catalog(),
    create: (providerId, cwd, model, effort, mode) => manager.create(providerId, cwd, model, effort, mode),
    setVisible: (ids) => manager.setVisible(ids as SessionId[]),
    summaries: () => manager.summaries(),
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
    recallRoot: (id) => manager.recallRootOfSession(id as SessionId),
  }, memory);
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
      systemPrompt: systemPrompts.claude,
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
    manager, store, attachments, providers, enabled, loginRecipes, selfControlServer,
    init: async () => {
      await manager.init();
      manager.startRosterSync(opts.pollMs);
    },
    dispose: async () => {
      await manager.dispose();
      await selfControlServer.dispose();
      await digestLock.dispose();
      fts?.close();
    },
  };
}

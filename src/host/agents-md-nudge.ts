export interface AgentsMdDirEntry {
  dir: string;
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
}

export interface AgentsMdNudgeHit {
  dir: string;
  kind: 'migrate' | 'add-stub';
}

const STUB_CONTENT = '@AGENTS.md\n';

const DEFAULT_EXCLUDE_GLOBS = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'];

/**
 * Pure: default excludes plus caller-supplied extra globs (from
 * `marcode.agentsMdNudge.excludePaths`), folded into one `findFiles`
 * exclude pattern. Bare directory names (no `*` or `/`) are treated as a
 * path segment anywhere in the tree, e.g. `.claude/worktrees` ->
 * `**\/.claude/worktrees/**`, matching what the default globs already do.
 */
export function buildExcludeGlob(extra: string[]): string {
  const normalized = extra
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (p.includes('*') ? p : `**/${p.replace(/^\/+|\/+$/g, '')}/**`));
  return `{${[...DEFAULT_EXCLUDE_GLOBS, ...normalized].join(',')}}`;
}

export interface AgentsMdHitPaths {
  claudeMdPath: string;
  agentsMdPath: string;
}

export interface AgentsMdFsOps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * Applies one hit's action. migrate reads the existing CLAUDE.md content,
 * writes it verbatim to a new AGENTS.md, then overwrites CLAUDE.md with the
 * stub. add-stub only ever writes the stub — AGENTS.md is already the
 * source of truth, nothing to move.
 */
export async function applyHit(
  hit: AgentsMdNudgeHit, paths: AgentsMdHitPaths, fs: AgentsMdFsOps,
): Promise<void> {
  if (hit.kind === 'migrate') {
    const content = await fs.readFile(paths.claudeMdPath);
    await fs.writeFile(paths.agentsMdPath, content);
  }
  await fs.writeFile(paths.claudeMdPath, STUB_CONTENT);
}

/**
 * Pure: workspace-relative POSIX file paths (from `findFiles`, already
 * filtered to CLAUDE.md/AGENTS.md basenames) -> one entry per directory.
 * A hit at the workspace root has dirname '.' (posix path.dirname behavior).
 */
export function groupIntoDirEntries(paths: string[]): AgentsMdDirEntry[] {
  const byDir = new Map<string, AgentsMdDirEntry>();
  for (const p of paths) {
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '.' : p.slice(0, slash);
    const base = slash === -1 ? p : p.slice(slash + 1);
    let entry = byDir.get(dir);
    if (!entry) {
      entry = { dir, hasClaudeMd: false, hasAgentsMd: false };
      byDir.set(dir, entry);
    }
    if (base === 'CLAUDE.md') {entry.hasClaudeMd = true;}
    if (base === 'AGENTS.md') {entry.hasAgentsMd = true;}
  }
  return [...byDir.values()];
}

export interface ScanDeps {
  hasClaudeProvider: boolean;
  dismissed: Set<string>;
}

/**
 * Pure: AGENTS.md is the source of truth. CLAUDE.md, when present, is only
 * ever a `@AGENTS.md` stub. A dir where that has drifted gets one hit:
 * migrate (CLAUDE.md has real content, no AGENTS.md) or add-stub (AGENTS.md
 * exists, no CLAUDE.md, and the claude provider is actually enabled — no
 * other provider reads CLAUDE.md, so there is nothing to add a stub for).
 */
export function scanForHits(entries: AgentsMdDirEntry[], deps: ScanDeps): AgentsMdNudgeHit[] {
  const hits: AgentsMdNudgeHit[] = [];
  for (const entry of entries) {
    if (deps.dismissed.has(entry.dir)) {continue;}
    if (entry.hasClaudeMd && !entry.hasAgentsMd) {
      hits.push({ dir: entry.dir, kind: 'migrate' });
    } else if (!entry.hasClaudeMd && entry.hasAgentsMd && deps.hasClaudeProvider) {
      hits.push({ dir: entry.dir, kind: 'add-stub' });
    }
  }
  return hits;
}

export interface AgentsMdDismissStore {
  get(): Set<string>;
  add(dirs: string[]): Promise<void>;
}

export interface AgentsMdNudgeDeps {
  findRelativePaths(): Promise<string[]>;
  hasClaudeProvider: boolean;
  dismiss: AgentsMdDismissStore;
  resolvePaths(dir: string): AgentsMdHitPaths;
  fs: AgentsMdFsOps;
  post(msg: { t: 'agents-md-nudge'; hits: Array<AgentsMdNudgeHit & { error?: string }> }): void;
}

/**
 * Owns the nudge card's lifecycle for one activation: scan once, then react
 * to migrate/dismiss actions from the webview. Deps are injected so this
 * stays testable without `vscode` — `extension.ts`/`panel-view-provider.ts`
 * supply the real `findFiles`/`workspaceState`/`fs` glue.
 */
export class AgentsMdNudgeController {
  private hits: Array<AgentsMdNudgeHit & { error?: string }> = [];

  constructor(private readonly deps: AgentsMdNudgeDeps) {}

  async scan(): Promise<void> {
    const paths = await this.deps.findRelativePaths();
    const entries = groupIntoDirEntries(paths);
    this.hits = scanForHits(entries, {
      hasClaudeProvider: this.deps.hasClaudeProvider,
      dismissed: this.deps.dismiss.get(),
    });
    this.post();
  }

  async handleAction(action: 'migrate' | 'dismiss', dirs: string[]): Promise<void> {
    const dirSet = new Set(dirs);
    const resolved: string[] = [];
    const errors = new Map<string, string>();

    if (action === 'dismiss') {
      resolved.push(...dirs);
    } else {
      for (const hit of this.hits.filter((h) => dirSet.has(h.dir))) {
        try {
          await applyHit(hit, this.deps.resolvePaths(hit.dir), this.deps.fs);
          resolved.push(hit.dir);
        } catch (err) {
          errors.set(hit.dir, err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (resolved.length) {await this.deps.dismiss.add(resolved);}

    this.hits = this.hits
      .filter((h) => !resolved.includes(h.dir))
      .map((h) => (errors.has(h.dir) ? { ...h, error: errors.get(h.dir) } : h));
    this.post();
  }

  private post(): void {
    this.deps.post({ t: 'agents-md-nudge', hits: this.hits });
  }
}

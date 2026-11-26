import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isWithin } from '../../shared/path-scope';
import { ownProjectId, projectIdFromRemote } from '../../shared/project-id';
import { git, type GitResult } from '../git-worktree';
import type { ProjectOverride } from '../host-config';

export interface ProjectRef { projectId: string; root: string }

type GitRunner = (cwd: string, args: string[]) => Promise<GitResult>;

async function nearestExisting(dir: string): Promise<string | undefined> {
  let at = path.resolve(dir);
  for (;;) {
    try {
      if ((await fs.stat(at)).isDirectory()) { return at; }
    } catch { /* keep walking up */ }
    const parent = path.dirname(at);
    if (parent === at) { return undefined; }
    at = parent;
  }
}

const MAX_CONCURRENT = 4;

export class ProjectResolver {
  private readonly cache = new Map<string, Promise<ProjectRef | undefined>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly overrides: ProjectOverride[],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: GitRunner = git,
  ) {}

  resolve(cwd: string): Promise<ProjectRef | undefined> {
    let hit = this.cache.get(cwd);
    if (!hit) {
      const pending: Promise<ProjectRef | undefined> = this.limited(() => this.lookup(cwd))
        .catch(() => ({ ref: undefined, transient: true }))
        .then((r) => {
          if (r.transient && this.cache.get(cwd) === pending) { this.cache.delete(cwd); }
          return r.ref;
        });
      hit = pending;
      this.cache.set(cwd, hit);
    }
    return hit;
  }

  private async limited<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) { await new Promise<void>((r) => this.waiting.push(r)); }
    this.running++;
    try {
      return await job();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async lookup(cwd: string): Promise<{ ref: ProjectRef | undefined; transient: boolean }> {
    const dir = await nearestExisting(cwd);
    if (!dir) { return { ref: undefined, transient: false }; }
    const top = await this.run(dir, ['rev-parse', '--show-toplevel']);
    if (top.transient) { return { ref: undefined, transient: true }; }
    const root = top.ok && top.out !== '' ? path.resolve(top.out) : undefined;
    const caseInsensitive = this.platform === 'win32' || this.platform === 'darwin';
    const override = this.overrides
      .filter((o) => isWithin(o.path, dir, caseInsensitive))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (override) {
      const projectId = override.project === 'own' ? ownProjectId(override.path, this.platform) : override.project;
      return { ref: { projectId, root: root ?? path.resolve(override.path) }, transient: false };
    }
    if (!root) { return { ref: undefined, transient: false }; }
    const origin = await this.run(root, ['config', '--get', 'remote.origin.url']);
    if (origin.transient) { return { ref: undefined, transient: true }; }
    const projectId = origin.ok ? projectIdFromRemote(origin.out) : undefined;
    return { ref: projectId ? { projectId, root } : undefined, transient: false };
  }
}

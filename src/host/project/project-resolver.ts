import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeWorkspacePath } from '../../shared/workspace-dir';
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

export class ProjectResolver {
  private readonly cache = new Map<string, Promise<ProjectRef | undefined>>();

  constructor(
    private readonly overrides: ProjectOverride[],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: GitRunner = git,
  ) {}

  resolve(cwd: string): Promise<ProjectRef | undefined> {
    let hit = this.cache.get(cwd);
    if (!hit) {
      hit = this.lookup(cwd).catch(() => undefined);
      this.cache.set(cwd, hit);
    }
    return hit;
  }

  private async lookup(cwd: string): Promise<ProjectRef | undefined> {
    const dir = await nearestExisting(cwd);
    if (!dir) { return undefined; }
    const top = await this.run(dir, ['rev-parse', '--show-toplevel']);
    if (!top.ok || top.out === '') { return undefined; }
    const root = path.resolve(top.out);
    const key = normalizeWorkspacePath(root, this.platform);
    const override = this.overrides.find((o) => normalizeWorkspacePath(o.path, this.platform) === key);
    if (override) {
      return { projectId: override.project === 'own' ? ownProjectId(root, this.platform) : override.project, root };
    }
    const origin = await this.run(root, ['config', '--get', 'remote.origin.url']);
    const projectId = origin.ok ? projectIdFromRemote(origin.out) : undefined;
    return projectId ? { projectId, root } : undefined;
  }
}

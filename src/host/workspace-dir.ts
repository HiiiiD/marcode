import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspacePath, slugOf } from '../shared/workspace-dir';
import { createExclusive } from './atomic-file';

export function marcodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.MARCODE_HOME || path.join(os.homedir(), '.marcode');
}

async function realOrSelf(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return p; }
}

async function claimDir(dir: string, key: string): Promise<boolean> {
  const marker = path.join(dir, 'workspace.json');
  if (await createExclusive(marker, JSON.stringify({ path: key }))) { return true; }
  try {
    const parsed = JSON.parse(await fs.readFile(marker, 'utf8')) as { path?: unknown };
    return parsed.path === key;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceDir(home: string, workspacePath: string | undefined): Promise<string> {
  const workspaces = path.join(home, 'workspaces');
  if (workspacePath === undefined) {
    const dir = path.join(workspaces, '_global');
    await claimDir(dir, '_global');
    return dir;
  }
  const key = normalizeWorkspacePath(await realOrSelf(workspacePath));
  const base = slugOf(key);
  for (let n = 1; ; n++) {
    const dir = path.join(workspaces, n === 1 ? base : `${base}-${n}`);
    if (await claimDir(dir, key)) { return dir; }
  }
}

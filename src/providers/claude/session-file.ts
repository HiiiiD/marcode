import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function sessionsRoot(env: NodeJS.ProcessEnv | undefined): string {
  const base = env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

export async function copySessionFile(root: string, from: string, to: string, sessionId: string): Promise<boolean> {
  try {
    const name = `${sessionId}.jsonl`;
    const destDir = path.join(root, projectSlug(to));
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(path.join(root, projectSlug(from), name), path.join(destDir, name));
    return true;
  } catch {
    return false;
  }
}

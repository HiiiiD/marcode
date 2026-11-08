import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextBreakdown } from '../types';

interface InstructionSdk {
  path: { get(params: { directory: string }, options: { throwOnError: true; signal: AbortSignal }):
    Promise<{ data?: { config: string; home: string; worktree: string; directory: string } }> };
  config: { get(params: { directory: string }, options: { throwOnError: true; signal: AbortSignal }):
    Promise<{ data?: { instructions?: string[] } }> };
}

function ancestors(start: string, stop: string): string[] {
  const dirs: string[] = [];
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (dir === path.resolve(stop) || path.dirname(dir) === dir) { return dirs; }
  }
}

async function readable(file: string): Promise<boolean> {
  try { return Boolean(await fs.readFile(file, 'utf8')); } catch { return false; }
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** Mirrors OpenCode's legacy ACP instruction discovery, using its server's resolved config/paths. */
export async function discoverInstructionFiles(
  sdk: InstructionSdk, directory: string, env: NodeJS.ProcessEnv,
): Promise<Pick<ContextBreakdown, 'memoryFiles' | 'memoryFilesDiscovery'>> {
  try {
    const options = { throwOnError: true as const, signal: AbortSignal.timeout(4000) };
    const [location, config] = await Promise.all([
      sdk.path.get({ directory }, options), sdk.config.get({ directory }, options),
    ]);
    if (!location.data || !config.data) { return { memoryFiles: [], memoryFilesDiscovery: 'unavailable' }; }
    const at = location.data;
    const paths = new Set<string>();
    const claude = !['true', '1'].includes(env.OPENCODE_DISABLE_CLAUDE_CODE ?? '')
      && !['true', '1'].includes(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ?? '');
    const project = !['true', '1'].includes(env.OPENCODE_DISABLE_PROJECT_CONFIG ?? '');
    for (const file of [path.join(at.config, 'AGENTS.md'), ...(claude ? [path.join(at.home, '.claude', 'CLAUDE.md')] : [])]) {
      if (await exists(file)) {
        if (await readable(file)) { paths.add(file); }
        break;
      }
    }
    const dirs = ancestors(at.directory, at.worktree);
    if (project) {
      for (const name of ['AGENTS.md', ...(claude ? ['CLAUDE.md'] : []), 'CONTEXT.md']) {
        const matches: string[] = [];
        for (const dir of dirs) {
          const file = path.join(dir, name);
          if (await exists(file)) { matches.push(file); }
        }
        if (matches.length) {
          for (const file of matches) {
            if (await readable(file)) { paths.add(file); }
          }
          break;
        }
      }
    }
    for (const raw of config.data.instructions ?? []) {
      if (/^https?:\/\//.test(raw)) { paths.add(raw); continue; }
      const pattern = raw.startsWith('~/') ? path.join(at.home, raw.slice(2)) : raw;
      const roots = path.isAbsolute(pattern) ? [path.dirname(pattern)] : project ? dirs : [at.config];
      for (const cwd of roots) {
        for await (const match of fs.glob(path.isAbsolute(pattern) ? path.basename(pattern) : pattern.replaceAll('\\', '/'), { cwd })) {
          const file = path.resolve(cwd, match);
          if (await readable(file)) { paths.add(file); }
        }
      }
    }
    return { memoryFiles: [...paths].map((path) => ({ path, source: 'discovered' })), memoryFilesDiscovery: 'complete' };
  } catch {
    return { memoryFiles: [], memoryFilesDiscovery: 'unavailable' };
  }
}

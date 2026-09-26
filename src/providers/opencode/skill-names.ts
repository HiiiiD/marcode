import { spawn as spawnChildProcess } from 'node:child_process';

const TIMEOUT_MS = 10_000;

/** Pulls the skill names out of `opencode debug skill`'s JSON, ignoring any log noise around it. */
export function parseSkillNames(stdout: string): Set<string> | undefined {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) { return undefined; }
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (!Array.isArray(parsed)) { return undefined; }
    return new Set(parsed.flatMap((s) => (
      typeof (s as { name?: unknown })?.name === 'string' ? [(s as { name: string }).name] : []
    )));
  } catch {
    return undefined;
  }
}

/**
 * ACP's command list mixes opencode's own commands with skills and marks
 * neither, so the skill list has to come from the CLI. `shell: true` for the
 * same Windows `.cmd` reason as `spawnOpenCodeAcp`. Resolves `undefined` on any
 * failure — the caller must not read that as "no skills".
 */
export function listOpenCodeSkillNames(
  binPath: string | undefined, env: NodeJS.ProcessEnv | undefined, cwd: string,
): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawnChildProcess(binPath ?? 'opencode', ['debug', 'skill'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], shell: true, windowsHide: true, ...(env ? { env } : {}),
    });
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('exit', () => { clearTimeout(timer); resolve(parseSkillNames(out)); });
  });
}

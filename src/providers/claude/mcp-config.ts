import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectKeysFor, readJsonMembers, removeJsonMember, setJsonMember } from '../../shared/jsonc-config';
import type {
  McpCapabilities, McpConfigStore, McpLocation, McpRemovableOrigin, McpScope, McpServerSpec, McpTarget,
} from '../types';

export type ExecCli = (
  file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecCli = (file, args, opts) => new Promise((resolve, reject) => {
  execFile(file, args, { ...opts, windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
    if (err) { reject(Object.assign(err, { stderr })); } else { resolve({ stdout, stderr }); }
  });
});

/** The CLI the SDK itself spawns — shipped beside it as a per-platform package. */
export function bundledClaudeCli(): string | undefined {
  try {
    const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    return path.join(sdkDir, '..', `claude-agent-sdk-${process.platform}-${process.arch}`, exe);
  } catch {
    return undefined;
  }
}

export function toClaudeJson(spec: McpServerSpec): Record<string, unknown> {
  return spec.transport === 'stdio'
    ? { type: 'stdio', command: spec.command, args: spec.args, env: spec.env }
    : { type: spec.transport, url: spec.url, headers: spec.headers };
}

export async function refuseTaken(file: string, keyPath: string[], name: string): Promise<void> {
  if ((await readJsonMembers(file, keyPath)).includes(name)) {
    throw new Error(`A server named ${name} is already in ${file}.`);
  }
}

// execFile reports a process that never started with a string errno (ENOENT, EACCES, EINVAL for a .cmd shim, …);
// one that ran and failed has a numeric exit code, and a timeout has `code: null`.
function isSpawnFailure(err: unknown): boolean {
  const { code, stderr } = err as { code?: unknown; stderr?: string };
  return typeof code === 'string' && !stderr?.trim();
}

function cliError(err: unknown): Error {
  const stderr = (err as { stderr?: string }).stderr?.trim();
  return new Error(stderr || (err instanceof Error ? err.message : String(err)));
}

/**
 * `~/.claude.json` is rewritten constantly by every running Claude process, so
 * user and per-project entries go through Claude's own CLI, which owns that
 * file's locking. A direct edit is the fallback when no CLI can be found.
 */
export class ClaudeMcpConfig implements McpConfigStore {
  readonly capabilities: McpCapabilities = { reconnect: 'per-server', signIn: false, sse: true, workingDirectory: false };
  private readonly env: NodeJS.ProcessEnv;
  private readonly cliPath: () => string | undefined;
  private readonly exec: ExecCli;

  constructor(opts: { env?: NodeJS.ProcessEnv; cliPath?: () => string | undefined; exec?: ExecCli } = {}) {
    this.env = opts.env ?? process.env;
    this.cliPath = opts.cliPath ?? bundledClaudeCli;
    this.exec = opts.exec ?? defaultExec;
  }

  private globalFile(): string {
    return path.join(this.env.CLAUDE_CONFIG_DIR ?? os.homedir(), '.claude.json');
  }

  async targets(at: McpLocation): Promise<Record<McpScope, McpTarget>> {
    return { repo: { path: path.join(at.repoRoot, '.mcp.json') }, global: { path: this.globalFile() } };
  }

  async add(at: McpLocation, scope: McpScope, server: McpServerSpec): Promise<string> {
    const body = toClaudeJson(server);
    if (scope === 'repo') {
      const file = path.join(at.repoRoot, '.mcp.json');
      await refuseTaken(file, ['mcpServers'], server.name);
      await setJsonMember(file, ['mcpServers', server.name], body);
      return file;
    }
    const file = this.globalFile();
    if (await this.viaCli(['mcp', 'add-json', server.name, JSON.stringify(body), '-s', 'user'], at.repoRoot)) { return file; }
    await refuseTaken(file, ['mcpServers'], server.name);
    await setJsonMember(file, ['mcpServers', server.name], body);
    await this.verify(file, ['mcpServers'], server.name, true);
    return file;
  }

  async remove(at: McpLocation, origin: McpRemovableOrigin, name: string): Promise<string> {
    if (origin === 'repo') {
      const file = path.join(at.repoRoot, '.mcp.json');
      if (!(await removeJsonMember(file, ['mcpServers', name]))) { throw new Error(`${name} isn't in ${file}.`); }
      return file;
    }
    const file = this.globalFile();
    if (origin === 'global') {
      if (await this.viaCli(['mcp', 'remove', name, '-s', 'user'], at.repoRoot)) { return file; }
      if (!(await removeJsonMember(file, ['mcpServers', name]))) { throw new Error(`${name} isn't in ${file}.`); }
      return file;
    }
    let cliFailure: unknown;
    // `-s local` is keyed by the process cwd: the session's own folder, which may sit below the repo root.
    try { await this.viaCli(['mcp', 'remove', name, '-s', 'local'], at.cwd); } catch (err) { cliFailure = err; }
    // The CLI only knows one spelling of the project path; Windows leaves others behind.
    let removed = false;
    const keys = new Set([...await projectKeysFor(file, at.cwd), ...await projectKeysFor(file, at.repoRoot)]);
    for (const key of keys) {
      removed = (await removeJsonMember(file, ['projects', key, 'mcpServers', name])) || removed;
    }
    if (cliFailure !== undefined && !removed) { throw cliFailure; }
    return file;
  }

  /** `false` when no CLI can be spawned; a CLI that ran and failed rejects with its own message. */
  private async viaCli(args: string[], cwd: string): Promise<boolean> {
    const cli = this.cliPath();
    if (!cli) { return false; }
    try {
      await this.exec(cli, args, { cwd, env: this.env });
      return true;
    } catch (err) {
      if (isSpawnFailure(err)) { return false; }
      throw cliError(err);
    }
  }

  private async verify(file: string, keyPath: string[], name: string, present: boolean): Promise<void> {
    if ((await readJsonMembers(file, keyPath)).includes(name) !== present) {
      throw new Error(`${file} changed while Marcode was editing it; try again.`);
    }
  }
}

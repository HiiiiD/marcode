import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonMembers, removeJsonMember, setJsonMember } from '../../shared/jsonc-config';
import type {
  McpCapabilities, McpConfigStore, McpLocation, McpOrigin, McpRemovableOrigin, McpScope, McpServerSpec, McpTarget,
} from '../types';

const INLINE = "This OpenCode instance sets its config inline (OPENCODE_CONFIG_CONTENT), so Marcode can't add servers to it.";

export function toOpenCodeValue(spec: McpServerSpec): Record<string, unknown> {
  return spec.transport === 'stdio'
    ? { type: 'local', command: [spec.command, ...spec.args], environment: spec.env, ...(spec.cwd ? { cwd: spec.cwd } : {}) }
    : { type: 'remote', url: spec.url, headers: spec.headers };
}

/** Nearest ancestor holding `.git` (a dir, or a worktree's file), else `cwd`. */
export function findRepoRoot(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) { return dir; }
    if (path.dirname(dir) === dir) { return cwd; }
  }
}

/** OpenCode follows XDG: `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, on every OS. */
export function defaultOpenCodeConfigDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'opencode');
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false);

/** `opencode.jsonc` when that is what the folder already has, else `opencode.json`. */
async function configFileIn(dir: string): Promise<string> {
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  return !(await exists(json)) && (await exists(jsonc)) ? jsonc : json;
}

export class OpenCodeMcpConfig implements McpConfigStore {
  readonly capabilities: McpCapabilities = { reconnect: 'per-server', signIn: true, sse: false, workingDirectory: true };
  private readonly env: NodeJS.ProcessEnv;
  private readonly configDir: () => Promise<string | undefined>;

  constructor(opts: { env?: NodeJS.ProcessEnv; configDir?: () => Promise<string | undefined> } = {}) {
    this.env = opts.env ?? process.env;
    this.configDir = opts.configDir ?? (async () => undefined);
  }

  private async globalTarget(): Promise<McpTarget> {
    if (this.env.OPENCODE_CONFIG_CONTENT) { return { unavailable: INLINE }; }
    if (this.env.OPENCODE_CONFIG) { return { path: this.env.OPENCODE_CONFIG }; }
    if (this.env.OPENCODE_CONFIG_DIR) { return { path: await configFileIn(this.env.OPENCODE_CONFIG_DIR) }; }
    const dir = (await this.configDir().catch(() => undefined)) ?? defaultOpenCodeConfigDir(this.env);
    return { path: await configFileIn(dir) };
  }

  async targets(at: McpLocation): Promise<Record<McpScope, McpTarget>> {
    return { repo: { path: await configFileIn(at.repoRoot) }, global: await this.globalTarget() };
  }

  private async fileFor(at: McpLocation, scope: McpScope): Promise<string> {
    const target = (await this.targets(at))[scope];
    if ('unavailable' in target) { throw new Error(target.unavailable); }
    return target.path;
  }

  async add(at: McpLocation, scope: McpScope, server: McpServerSpec): Promise<string> {
    const file = await this.fileFor(at, scope);
    if ((await readJsonMembers(file, ['mcp'])).includes(server.name)) {
      throw new Error(`A server named ${server.name} is already in ${file}.`);
    }
    await setJsonMember(file, ['mcp', server.name], toOpenCodeValue(server));
    return file;
  }

  async remove(at: McpLocation, origin: McpRemovableOrigin, name: string): Promise<string> {
    if (origin === 'repo-private') { throw new Error('OpenCode has no per-repo private config.'); }
    const file = await this.fileFor(at, origin);
    if (!(await removeJsonMember(file, ['mcp', name]))) { throw new Error(`${name} isn't in ${file}.`); }
    return file;
  }

  /** Project config overrides global in OpenCode, so a name in both is the repo's. */
  async origins(at: McpLocation): Promise<Map<string, McpOrigin>> {
    const out = new Map<string, McpOrigin>();
    const t = await this.targets(at);
    const names = async (target: McpTarget) => ('path' in target ? readJsonMembers(target.path, ['mcp']).catch(() => []) : []);
    for (const name of await names(t.global)) { out.set(name, 'global'); }
    for (const name of await names(t.repo)) { out.set(name, 'repo'); }
    return out;
  }
}

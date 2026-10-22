import * as os from 'node:os';
import * as path from 'node:path';
import { addTomlServer, removeTomlServer } from '../../shared/toml-mcp';
import type {
  McpCapabilities, McpConfigStore, McpLocation, McpRemovableOrigin, McpScope, McpServerSpec, McpTarget,
} from '../types';

export type CodexRequest = <T>(method: string, params: unknown) => Promise<T>;

interface Layer { name?: { type?: string }; config?: { mcp_servers?: Record<string, unknown> }; disabledReason?: string | null }
export interface ConfigReadLike { layers?: Layer[] | null }

export function toCodexValue(spec: McpServerSpec): Record<string, unknown> {
  if (spec.transport === 'stdio') {
    return { command: spec.command, args: spec.args, ...(spec.cwd ? { cwd: spec.cwd } : {}), env: spec.env };
  }
  return { url: spec.url, http_headers: spec.headers };
}

/**
 * User config goes through the app-server's own writer (it keeps formatting and
 * hot-reloads). It refuses project files, so the repo file is edited in place.
 */
export class CodexMcpConfig implements McpConfigStore {
  readonly capabilities: McpCapabilities = { reconnect: 'restart', signIn: true, sse: false, workingDirectory: true };

  constructor(private readonly deps: { request: CodexRequest; env?: NodeJS.ProcessEnv }) {}

  private repoFile(at: McpLocation): string { return path.join(at.repoRoot, '.codex', 'config.toml'); }

  private userFile(): string {
    return path.join((this.deps.env ?? process.env).CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml');
  }

  async targets(at: McpLocation): Promise<Record<McpScope, McpTarget>> {
    let note: string | undefined;
    try {
      const read = await this.deps.request<ConfigReadLike>('config/read', { includeLayers: true, cwd: at.cwd });
      note = read.layers?.find((l) => l.name?.type === 'project' && l.disabledReason)?.disabledReason ?? undefined;
    } catch {
      note = undefined;
    }
    return {
      repo: { path: this.repoFile(at), ...(note ? { note: `Codex ignores this file for now: ${note}` } : {}) },
      global: { path: this.userFile() },
    };
  }

  async add(at: McpLocation, scope: McpScope, server: McpServerSpec): Promise<string> {
    const value = toCodexValue(server);
    if (scope === 'repo') {
      const file = this.repoFile(at);
      await addTomlServer(file, server.name, value as Parameters<typeof addTomlServer>[2]);
      return file;
    }
    const read = await this.deps.request<ConfigReadLike>('config/read', { includeLayers: true, cwd: at.cwd });
    const user = read.layers?.find((l) => l.name?.type === 'user');
    if (Object.keys(user?.config?.mcp_servers ?? {}).includes(server.name)) {
      throw new Error(`A server named ${server.name} is already in ${this.userFile()}.`);
    }
    return this.writeUser(server.name, value);
  }

  async remove(at: McpLocation, origin: McpRemovableOrigin, name: string): Promise<string> {
    if (origin === 'repo') {
      const file = this.repoFile(at);
      if (!(await removeTomlServer(file, name))) { throw new Error(`${name} isn't in ${file}.`); }
      return file;
    }
    if (origin === 'repo-private') { throw new Error("Codex has no per-repo private config."); }
    return this.writeUser(name, null);
  }

  private async writeUser(name: string, value: unknown): Promise<string> {
    const result = await this.deps.request<{ filePath?: string }>('config/batchWrite', {
      edits: [{ keyPath: `mcp_servers.${name}`, value, mergeStrategy: 'replace' }],
      reloadUserConfig: true,
    });
    return result.filePath ?? this.userFile();
  }
}

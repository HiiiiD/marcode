import { normalizeWorkspacePath } from './workspace-dir';

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function trimRepoPath(p: string): string {
  return p.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
}

/** Scheme, credentials, port, trailing `/` and `.git` are dropped and the host lowercased; path case is kept. */
export function projectIdFromRemote(url: string): string | undefined {
  const raw = url.trim();
  if (raw === '') { return undefined; }

  if (raw.startsWith('file://')) { return `file:/${trimRepoPath(raw.slice('file://'.length))}`; }
  if (raw.startsWith('/')) { return `file:/${trimRepoPath(raw)}`; }
  if (WINDOWS_DRIVE.test(raw)) { return `file:${trimRepoPath(raw.replace(/\\/g, '/'))}`; }

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  if (scheme) {
    const rest = raw.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const repoPath = slash < 0 ? '' : rest.slice(slash);
    const host = authority.replace(/^.*@/, '').replace(/:\d*$/, '').toLowerCase();
    const trimmed = trimRepoPath(repoPath);
    return host === '' || trimmed === '' ? undefined : `${host}/${trimmed}`;
  }

  const scp = SCP_LIKE.exec(raw);
  if (scp) {
    const trimmed = trimRepoPath(scp[2]);
    return trimmed === '' ? undefined : `${scp[1].toLowerCase()}/${trimmed}`;
  }
  return undefined;
}

export function ownProjectId(checkoutRoot: string, platform: NodeJS.Platform = process.platform): string {
  return `local:${normalizeWorkspacePath(checkoutRoot, platform)}`;
}

import { execFile } from 'node:child_process';

export interface UpdateInfo { current: string; latest: string; }

/**
 * First `x.y.z` substring found, or undefined. Both a CLI's `--version`
 * banner and a GitHub `tag_name` can carry a leading name/prefix — this
 * strips it implicitly by only ever matching the digits-and-dots run.
 */
export function extractVersion(text: string): string | undefined {
  const match = text.match(/(\d+\.\d+\.\d+)/);
  return match?.[1];
}

function parts(v: string): number[] | undefined {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) { return undefined; }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Dotted-numeric compare. True only when `latest` is strictly newer than
 * `current`. Malformed input on either side returns false — never a false
 * "update available", per the spec's error-as-state requirement.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parts(latest);
  const b = parts(current);
  if (!a || !b) { return false; }
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) { return true; }
    if (a[i] < b[i]) { return false; }
  }
  return false;
}

export type ExecVersionFn = (bin: string, args: string[]) => Promise<{ stdout: string }>;
export type FetchFn = typeof fetch;

/**
 * Real, child-process-backed default — the production implementation,
 * injected away in every test above. `shell: true` for the same reason
 * `spawnOpenCodeAcp` needs it: on Windows these binaries resolve to `.cmd`
 * shims that a direct (non-shell) spawn refuses to launch.
 */
const realExecVersion: ExecVersionFn = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { shell: true, windowsHide: true, timeout: 5000 }, (err, stdout) => {
    if (err) { reject(err); return; }
    resolve({ stdout });
  });
});

/**
 * Runs `<bin> <args>` (defaults to `--version`) and extracts a version from
 * its stdout. Resolves undefined on any spawn failure or unparseable
 * output — never rejects, so a caller never needs a try/catch around this.
 */
export async function localVersion(
  bin: string, args: string[] = ['--version'], execVersionFn: ExecVersionFn = realExecVersion,
): Promise<string | undefined> {
  try {
    const { stdout } = await execVersionFn(bin, args);
    return extractVersion(stdout);
  } catch (err) {
    console.warn('[mar-code] update-check: local version probe failed for', bin, err);
    return undefined;
  }
}

/** `GET https://registry.npmjs.org/<pkg>/latest`, reads `.version`. Never rejects. */
export async function npmLatestVersion(
  pkg: string, fetchFn: FetchFn = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(
      `https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) { return undefined; }
    const json = await res.json() as { version?: string };
    return json.version;
  } catch (err) {
    console.warn('[mar-code] update-check: npm latest-version lookup failed for', pkg, err);
    return undefined;
  }
}

/**
 * `GET https://api.github.com/repos/<repo>/releases/latest`, reads
 * `.tag_name`, strips `tagPrefix` if present. Never rejects.
 */
export async function githubLatestVersion(
  repo: string, tagPrefix: string, fetchFn: FetchFn = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${repo}/releases/latest`, { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) { return undefined; }
    const json = await res.json() as { tag_name?: string };
    if (!json.tag_name) { return undefined; }
    const stripped = json.tag_name.startsWith(tagPrefix)
      ? json.tag_name.slice(tagPrefix.length) : json.tag_name;
    return extractVersion(stripped);
  } catch (err) {
    console.warn('[mar-code] update-check: github latest-release lookup failed for', repo, err);
    return undefined;
  }
}

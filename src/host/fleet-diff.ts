// What changed in a working tree, and against what.
//
// The same two rules as `git-worktree.ts`, and for the same reasons:
//
//  - **Every failure is a returned reason, never a throw.** A tree that
//    cannot be read becomes a row saying why, exactly as a refused
//    `bringBackPlan` stays a `StaleTree` row.
//  - **Never `shell: true`.** Paths contain spaces, and this is the boundary
//    where a directory name would otherwise become shell syntax.
//
// No `vscode` import: this is unit-tested outside the extension host.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChangeOp, DiffBase, FileChange } from '../protocol/messages';

const execFileAsync = promisify(execFile);

export type RawChange = Omit<FileChange, 'claimedBy'>;

/**
 * A tree with more changed files than this is a tree nobody reviews in a
 * sidebar. The remainder is *reported*, never silently dropped — a truncated
 * list reads as "that's everything" when it isn't.
 */
export const FILE_CAP = 500;

/**
 * The hard ceiling on a raised cap.
 *
 * The surface can ask for more than `FILE_CAP` — "N more files are not shown"
 * with nothing to press is a named dead end — but it cannot ask for
 * everything. Each file costs a numstat row to parse and a React row to
 * render, and a request with no ceiling is a request the host cannot promise
 * to answer.
 */
export const MAX_FILE_CAP = 2000;

/**
 * A requested cap, made safe. Nonsense (zero, negative, NaN) falls back to the
 * default rather than to zero rows: answering "nothing changed" because a
 * number arrived malformed is the one wrong answer this surface can give.
 */
export function clampCap(requested: number | undefined): number {
  // `Infinity` is nonsense as an unbounded request, but it is still a
  // direction — up — so it clamps to the ceiling below rather than falling
  // back to the default. Only `NaN` (not a number at all) and non-positive
  // values fall back.
  if (requested === undefined || Number.isNaN(requested) || requested < 1) {
    return FILE_CAP;
  }
  return Math.min(Math.floor(requested), MAX_FILE_CAP);
}

/**
 * `core.quotepath=false` on every call: git otherwise escapes non-ASCII paths
 * into octal (`"caf\303\251.ts"`), which would never match a path a provider
 * reported and would silently lose that file's attribution.
 */
async function git(cwd: string, args: string[]) {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-c', 'core.quotepath=false', ...args],
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true as const, out: stdout.trimEnd() };
  } catch (error) {
    const shaped = error as { stderr?: string; message?: string };
    return { ok: false as const, err: (shaped.stderr ?? shaped.message ?? 'git failed').trim() };
  }
}

const FALLBACK_REFS = ['origin/main', 'origin/master', 'main', 'master'];

/**
 * The ref this tree's work should be read against, in descending order of
 * confidence. `head` is the honest floor: it means the answer covers
 * uncommitted work only, and the UI says so rather than implying a branch
 * point it could not find.
 */
export async function resolveBase(dir: string): Promise<DiffBase> {
  const candidates: string[] = [];

  const symbolic = await git(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic.ok && symbolic.out !== '') {
    candidates.push(symbolic.out.replace(/^refs\/remotes\//, ''));
  }
  candidates.push(...FALLBACK_REFS);

  for (const ref of candidates) {
    const exists = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (!exists.ok || exists.out === '') { continue; }
    const mergeBase = await git(dir, ['merge-base', ref, 'HEAD']);
    if (!mergeBase.ok || mergeBase.out === '') { continue; }
    // A base identical to HEAD anchors nothing beyond what HEAD already
    // anchors, and claiming a branch point that is HEAD would put a
    // misleading ref in the caption.
    const head = await git(dir, ['rev-parse', 'HEAD']);
    if (head.ok && head.out === mergeBase.out) { return { kind: 'head' }; }
    return { kind: 'merge-base', ref, sha: mergeBase.out };
  }

  return { kind: 'head' };
}

/** `src/{old => new}.ts` and `old.ts => new.ts` are both git rename spellings. */
function splitRename(raw: string): { from?: string; path: string } {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    const [, prefix, before, after, suffix] = braced;
    return {
      from: `${prefix}${before}${suffix}`.replace(/\/\//g, '/'),
      path: `${prefix}${after}${suffix}`.replace(/\/\//g, '/'),
    };
  }
  const at = raw.indexOf(' => ');
  if (at >= 0) {
    return { from: raw.slice(0, at).trim(), path: raw.slice(at + 4).trim() };
  }
  return { path: raw };
}

/**
 * `--numstat` is three tab-separated fields. A binary file reports `-` for
 * both counts, which becomes `undefined` rather than 0 — zero would read as
 * "nothing changed", and something plainly did.
 */
export function parseNumstat(out: string): RawChange[] {
  const rows: RawChange[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') { continue; }
    const [ins, del, ...rest] = line.split('\t');
    if (rest.length === 0) { continue; }
    const { from, path } = splitRename(rest.join('\t'));
    const insertions = ins === '-' ? undefined : Number(ins);
    const deletions = del === '-' ? undefined : Number(del);
    // `--numstat` cannot distinguish a delete from a modify — that needs
    // `--name-status`, a third command for a distinction the row already
    // implies (all deletions, no insertions). Rename is the one op it does
    // report, via the arrow spelling, so it is the one op read here.
    const op: ChangeOp = from !== undefined ? 'rename' : 'modify';
    rows.push({ path, from, op, insertions, deletions });
  }
  return rows;
}

/**
 * The whole change set for one tree, in two commands.
 *
 * `git diff <base>` — deliberately with no `..HEAD` — compares the *working
 * tree* against the base, so committed and uncommitted changes arrive
 * together, already merged per path. Committed-only and uncommitted-only
 * would each need their own command and then a merge pass; this needs
 * neither, and it is what lets the surface be live during a turn.
 *
 * `ls-files --others` is the second command because `diff` cannot see an
 * untracked file, and an agent creating a new file is the most common change
 * there is.
 */
export async function treeChanges(
  dir: string,
  cap?: number,
): Promise<{ base: DiffBase; files: RawChange[]; omitted: number } | { reason: string }> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return { reason: `${dir} is not a git repository.` };
  }

  const base = await resolveBase(dir);
  const against = base.kind === 'merge-base' ? base.sha : 'HEAD';

  const diff = await git(dir, ['diff', '--numstat', '-M', against]);
  if (!diff.ok) { return { reason: `Could not read this tree's changes: ${diff.err}` }; }

  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard']);
  const files = parseNumstat(diff.out);
  if (untracked.ok) {
    for (const path of untracked.out.split('\n')) {
      if (path.trim() === '') { continue; }
      // No counts: reading every new file on every refresh, during a turn, is
      // a cost this view refuses to pay for a number nobody sorts by.
      files.push({ path, op: 'create' });
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const limit = clampCap(cap);
  const omitted = Math.max(0, files.length - limit);
  return { base, files: files.slice(0, limit), omitted };
}

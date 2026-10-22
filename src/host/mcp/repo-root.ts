import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

/** The session's git root, or its cwd outside a repo. One git spawn: this runs on every `/mcp` message. */
export function resolveRepoRoot(cwd: string): Promise<string> {
  return new Promise((done) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true }, (err, stdout) => {
      const top = String(stdout ?? '').trim();
      done(err || top === '' ? cwd : resolve(top));
    });
  });
}

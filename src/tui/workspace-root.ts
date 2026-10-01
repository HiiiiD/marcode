import { execFile } from 'node:child_process';

export function findGitRoot(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--show-toplevel'], { cwd }, (err, stdout) => {
      const top = stdout.trim();
      resolve(err || top === '' ? cwd : top);
    });
  });
}

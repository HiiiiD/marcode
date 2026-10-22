import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Windows scanners and indexers can hold a fresh file well past 200ms; the
// daemon dies at startup if its daemon.json rename loses that race.
const MAX_ATTEMPTS = 10;
const RETRY_STEP_MS = 50;

function tmpName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= MAX_ATTEMPTS - 1 || !RETRYABLE.has(code)) { throw err; }
      // Unconditional: the daemon never sees marcode.debug, and this only fires when a rename already failed.
      console.warn(`[marcode:atomic-rename] ${code} on ${path.basename(to)}, attempt ${attempt + 1}/${MAX_ATTEMPTS}`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_STEP_MS * (attempt + 1)));
    }
  }
}

export async function writeFileAtomic(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    await fs.writeFile(tmp, body, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
    throw err;
  }
}

/**
 * `wx` alone is not enough: it creates the file empty before the body lands,
 * so a concurrent reader can see a valid-looking but empty lock. A hard link
 * publishes the finished file in one step. Filesystems without hard links fall
 * back to `wx`, which is best-effort and non-atomic: callers must treat an
 * empty or unparsable file as "no live owner".
 */
export async function createExclusive(file: string, body: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  try {
    await fs.writeFile(tmp, body, 'utf8');
    await fs.link(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') { return false; }
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EXDEV') {
      try {
        await fs.writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === 'EEXIST') { return false; }
        throw inner;
      }
    }
    throw err;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
  }
}

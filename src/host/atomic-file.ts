import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

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
      if (attempt >= 4 || !RETRYABLE.has(code)) { throw err; }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
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
 * back to `wx`.
 */
export async function createExclusive(file: string, body: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpName(file);
  await fs.writeFile(tmp, body, 'utf8');
  try {
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

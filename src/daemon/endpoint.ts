import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export function endpointFor(workspaceDir: string, platform: NodeJS.Platform = process.platform): string {
  const id = createHash('sha256').update(workspaceDir).digest('hex').slice(0, 12);
  if (platform === 'win32') { return `\\\\.\\pipe\\marcode-${id}`; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `marcode-${uid}`, `${id}.sock`);
}

import { createHash } from 'node:crypto';
import * as path from 'node:path';

const MAX_SLUG = 80;
const KEPT = 64;

export function normalizeWorkspacePath(input: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  let p = (win ? path.win32 : path.posix).resolve(input).replace(/\\/g, '/');
  if (p.length > 1 && p.endsWith('/')) { p = p.slice(0, -1); }
  if (win || platform === 'darwin') { p = p.toLowerCase(); }
  return p;
}

export function slugOf(normalized: string): string {
  const slug = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= MAX_SLUG) { return slug; }
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `${slug.slice(0, KEPT)}-${hash}`;
}

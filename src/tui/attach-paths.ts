import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function existingFileUris(paths: string[]): string[] | undefined {
  if (paths.length === 0) { return undefined; }
  for (const path of paths) {
    try { if (!statSync(path).isFile()) { return undefined; } } catch { return undefined; }
  }
  return paths.map((path) => pathToFileURL(path).href);
}

/** Last path segment. The full path lives in a title; 300px has no room for it. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export { formatTokens } from '../client-core/format-tokens';

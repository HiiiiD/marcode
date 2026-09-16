/** Last path segment. The full path lives in a title; 300px has no room for it. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const compactTokens = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  return compactTokens.format(n);
}

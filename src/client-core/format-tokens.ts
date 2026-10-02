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

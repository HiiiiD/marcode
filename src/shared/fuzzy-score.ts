export const DEFAULT_MIN_SCORE = 0.8;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) { return 1; }
  if (!a.length || !b.length) { return 0; }
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched: boolean[] = new Array(a.length).fill(false);
  const bMatched: boolean[] = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true; bMatched[j] = true; matches++;
        break;
      }
    }
  }
  if (matches === 0) { return 0; }
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) { continue; }
    while (!bMatched[k]) { k++; }
    if (a[i] !== b[k]) { transpositions++; }
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) { prefix++; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * 0–1 similarity. Jaro-Winkler alone ranks "sonnet 5" poorly against
 * "claude-sonnet-5" (long unmatched prefix), so a query whose tokens all
 * appear in the candidate is floored at 0.9, capped below an exact match.
 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) { return 0; }
  if (q === c) { return 1; }
  const jw = jaroWinkler(q, c);
  const tokens = q.split(' ');
  if (tokens.every((t) => c.includes(t))) {
    const coverage = q.replace(/ /g, '').length / c.replace(/ /g, '').length;
    return Math.max(jw, 0.9 + 0.09 * Math.min(1, coverage));
  }
  return jw;
}

export function rankByQuery<T>(
  query: string, items: readonly T[], fields: (item: T) => (string | undefined)[], minScore = DEFAULT_MIN_SCORE,
): { item: T; score: number }[] {
  return items
    .map((item) => ({
      item,
      score: Math.max(0, ...fields(item).map((f) => (f ? fuzzyScore(query, f) : 0))),
    }))
    .filter((r) => r.score >= minScore)
    .sort((x, y) => y.score - x.score);
}

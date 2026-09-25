const normalize = (p: string, caseInsensitive: boolean): string => {
  const slashed = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? slashed.toLowerCase() : slashed;
};

/** Whether `path` is `root` or lives under it. Separator- and trailing-slash-insensitive; never a bare prefix match. */
export function isWithin(root: string, path: string, caseInsensitive = process.platform === 'win32'): boolean {
  const r = normalize(root, caseInsensitive);
  const p = normalize(path, caseInsensitive);
  return p === r || p.startsWith(`${r}/`);
}

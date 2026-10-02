const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', md: 'markdown', markdown: 'markdown',
};

export function filetypeOf(path: string | undefined): string | undefined {
  if (!path) { return undefined; }
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? undefined : BY_EXT[name.slice(dot + 1).toLowerCase()];
}

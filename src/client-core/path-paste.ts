const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

// Backslash only escapes a space: on Windows it is the path separator.
function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) { quote = null; } else { cur += c; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '\\' && text[i + 1] === ' ') { cur += ' '; i++; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (quote) { return []; }
  if (started) { out.push(cur); }
  return out;
}

function fromFileUri(uri: string): string | undefined {
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  if (url.protocol !== 'file:') { return undefined; }
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
  return /^\/[a-zA-Z]:/.test(path) ? path.slice(1) : path;
}

/** The absolute paths in `text`, or `[]` unless every token in it is one. */
export function parsePastedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const token of tokenize(text)) {
    const path = token.startsWith('file://') ? fromFileUri(token) : token;
    if (path === undefined || !ABSOLUTE.test(path)) { return []; }
    paths.push(path);
  }
  return paths;
}

const ATTACH = /^\/attach(?:\s+([\s\S]*))?$/;

/** `undefined` when `text` is not the `/attach` command; `[]` when it is but names no usable path. */
export function parseAttachCommand(text: string): string[] | undefined {
  const match = ATTACH.exec(text.trim());
  if (!match) { return undefined; }
  return parsePastedPaths(match[1] ?? '');
}

/**
 * A dropped `text/uri-list` entry as a filesystem path.
 *
 * Deliberately not `vscode.Uri.parse`: MessageRouter stays free of `vscode`
 * so it can run in unit tests. Anything but a plain file URI is ignored.
 */
export function fsPathOfUri(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'file:') { return undefined; }
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

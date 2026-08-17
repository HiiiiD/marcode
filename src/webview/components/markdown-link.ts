/**
 * What a markdown href in agent output actually denotes, decided in the
 * webview because the two answers go to two different host messages: a URL is
 * `open-external` (the OS browser), a path is `reveal-file` (an editor pane).
 *
 * Pure and React-free so the classification — which is where every edge lives
 * — is unit-tested without a DOM.
 */
export type MarkdownLink =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; startLine: number | undefined }
  | { kind: 'none' };

/** RFC 3986 scheme, which permits a single letter — hence the drive check. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * `e:\repo\a.ts` and `C:/repo/a.ts` both satisfy SCHEME with a one-letter
 * scheme. A path is the likelier reading of a single letter followed by a
 * separator, and the unlikelier one (a real `e:` protocol handler) is not
 * something this panel should hand to the OS.
 */
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

/**
 * Not a general allowlist — the panel opens unknown schemes and lets VS Code
 * apply its own trusted-domain prompt. These three are excluded because they
 * name a script to run rather than a place to go, and `openExternal` resolves
 * them outside this process where the webview's CSP no longer applies.
 */
const SCRIPT_SCHEMES = new Set(['javascript', 'data', 'vbscript']);

const HASH_LINE = /#L(\d+)$/;
const COLON_LINE = /:(\d+)$/;

export function classifyHref(href: string | undefined): MarkdownLink {
  const raw = href?.trim();
  if (!raw || raw.startsWith('#')) { return { kind: 'none' }; }

  if (!WINDOWS_DRIVE.test(raw)) {
    const scheme = SCHEME.exec(raw)?.[1];
    if (scheme) {
      return SCRIPT_SCHEMES.has(scheme.toLowerCase())
        ? { kind: 'none' }
        : { kind: 'external', url: raw };
    }
  }

  const line = HASH_LINE.exec(raw) ?? COLON_LINE.exec(raw);
  const path = line ? raw.slice(0, line.index) : raw;
  return {
    kind: 'file',
    path: decodePath(path),
    startLine: line ? Number(line[1]) : undefined,
  };
}

/**
 * A path with a space is spelled `%20` by every tool that writes markdown, so
 * an undecoded one names a file that does not exist. A path containing a
 * literal `%` is not an escape sequence at all and must survive unchanged, so
 * the failure is the answer rather than an error.
 */
function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

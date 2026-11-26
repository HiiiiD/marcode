import { isIP } from 'node:net';

export type UrlVerdict = { ok: true; base: string } | { ok: false; reason: string };

function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.local') || bare === '::1') { return true; }
  if (isIP(bare) !== 4) { return false; }
  const [a, b] = bare.split('.').map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 100 && b >= 64 && b <= 127);
}

/** Plain http only where the traffic cannot leave a trusted network: loopback, LAN, Tailscale. */
export function checkServerUrl(input: string): UrlVerdict {
  let url: URL;
  try { url = new URL(input.trim()); } catch { return { ok: false, reason: `"${input}" is not a URL.` }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `Use an https:// address (got ${url.protocol}).` };
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return { ok: false, reason: `Plain http:// is only allowed on loopback, LAN or Tailscale addresses; use https:// for ${url.hostname}.` };
  }
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  return { ok: true, base };
}

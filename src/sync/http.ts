export type Reply = { ok: true; status: number; json: Record<string, unknown> } | { ok: false; error: string };

export const REQUEST_TIMEOUT_MS = 30_000;

/** One JSON request to the sync server. Never throws: a network failure, a timeout or an error status is a `Reply`. */
export async function request(
  doFetch: typeof fetch, server: string, method: string, route: string,
  opts: { body?: unknown; token?: string; timeoutMs?: number } = {},
): Promise<Reply> {
  let res: Response;
  let text: string;
  try {
    res = await doFetch(`${server}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    return { ok: false, error: `Cannot reach ${server}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* a non-JSON error page */ }
  if (res.status === 401) { return { ok: false, error: 'This device was revoked or is unknown to the sync server.' }; }
  if (res.status >= 400 && res.status !== 409) {
    return { ok: false, error: `Sync server answered ${res.status}: ${typeof json.error === 'string' ? json.error : res.statusText}` };
  }
  return { ok: true, status: res.status, json };
}

export const isUnreachable = (reply: Reply): boolean => !reply.ok && reply.error.startsWith('Cannot reach');

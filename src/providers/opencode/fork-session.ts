import { MOVE_POST_TIMEOUT_MS, type MoveFetch } from './move-session';

export async function postForkSession(
  baseUrl: string, token: string, sessionID: string, fetchFn: MoveFetch = fetch,
): Promise<string | false> {
  try {
    const res = await fetchFn(`${baseUrl}/session/${encodeURIComponent(sessionID)}/fork`, {
      method: 'POST',
      signal: AbortSignal.timeout(MOVE_POST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`,
      },
      body: '{}',
    });
    if (res.status < 200 || res.status >= 300) { return false; }
    const body = await res.json() as { id?: unknown };
    return typeof body.id === 'string' && body.id !== '' ? body.id : false;
  } catch {
    return false;
  }
}

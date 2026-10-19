const MOVE_PATH = '/experimental/control-plane/move-session';

export const MOVE_POST_TIMEOUT_MS = 4000;

export type MoveFetch = typeof fetch;

export async function postMoveSession(
  baseUrl: string, token: string, sessionID: string, directory: string,
  fetchFn: MoveFetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseUrl}${MOVE_PATH}`, {
      method: 'POST',
      signal: AbortSignal.timeout(MOVE_POST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`,
      },
      body: JSON.stringify({ sessionID, destination: { directory }, moveChanges: false }),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** Any HTTP answer counts as up; only a refused connection means not yet. */
export async function waitForServer(
  baseUrl: string, fetchFn: MoveFetch, isDead: () => boolean, budgetMs: number, intervalMs: number, probeMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !isDead()) {
    try {
      await fetchFn(baseUrl, { signal: AbortSignal.timeout(probeMs) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

import { deriveTokens, type TerminalColorsLike, type TuiTokens } from './derive-tokens';

export async function detectTokens(
  renderer: { getPalette(options?: { timeout?: number }): Promise<TerminalColorsLike> },
  timeoutMs = 400,
): Promise<TuiTokens | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const never = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, timeoutMs); });
  try {
    const colors = await Promise.race([renderer.getPalette({ timeout: timeoutMs }), never]);
    return colors ? deriveTokens(colors) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

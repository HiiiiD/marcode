import type { ThemeColors } from '../../../shared/theme-settings';
import { deriveTokens, type TerminalColorsLike, type TuiTokens } from './derive-tokens';

// A terminal that cannot report its palette still gets a theme that sets background and foreground.
const SILENT: TerminalColorsLike = { palette: [], defaultForeground: null, defaultBackground: null };

export async function detectTokens(
  renderer: { getPalette(options?: { timeout?: number }): Promise<TerminalColorsLike> },
  timeoutMs = 1500,
  theme: ThemeColors = {},
): Promise<TuiTokens | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const never = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, timeoutMs); });
  try {
    const colors = await Promise.race([renderer.getPalette({ timeout: timeoutMs }), never]);
    return deriveTokens(colors ?? SILENT, theme);
  } catch {
    return deriveTokens(SILENT, theme);
  } finally {
    clearTimeout(timer);
  }
}

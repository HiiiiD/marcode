import { Surface } from './surface';
import { useTokens } from './tokens/tokens-provider';

export function ForeignBanner({ text }: { text: string }) {
  const muted = useTokens()?.textMuted ?? 'gray';
  return (
    <Surface tone="panel" padX={1}>
      <text fg={muted}>{text}</text>
    </Surface>
  );
}

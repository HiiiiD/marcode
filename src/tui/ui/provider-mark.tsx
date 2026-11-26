import { useTuiStore } from './store';
import { useTheme } from './termcn/hooks/use-theme';

// One cell each, never emoji: a double-width glyph would push every row off the label column.
const KIND_MARKS: Record<string, { text: string; color?: string }> = {
  claude: { text: '✻', color: '#D97757' },
  codex: { text: '◎', color: '#7A9DFF' },
  opencode: { text: '▣' },
};

/** A provider's mark: the instance's own icon when `providerInstances` configures one, else its kind's glyph. */
export function useProviderMark(providerId: string | undefined): { text: string; color: string } {
  const { state } = useTuiStore();
  const theme = useTheme();
  const entry = state.catalog.find((p) => p.id === providerId);
  if (entry?.icon) { return { text: [...entry.icon.text].slice(0, 2).join('') || '?', color: entry.icon.color ?? theme.colors.foreground }; }
  const kind = entry?.kind ?? providerId?.split(/[-:]/)[0];
  const mark = kind === undefined ? undefined : KIND_MARKS[kind];
  if (mark) { return { text: mark.text, color: mark.color ?? theme.colors.foreground }; }
  return { text: (providerId?.[0] ?? '?').toUpperCase(), color: theme.colors.mutedForeground };
}

export function ProviderMark({ providerId }: { providerId: string | undefined }) {
  const mark = useProviderMark(providerId);
  return <text fg={mark.color} flexShrink={0}>{mark.text}</text>;
}

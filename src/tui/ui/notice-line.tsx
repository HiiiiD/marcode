import { useTuiStore } from './store';
import { useTheme } from './termcn/hooks/use-theme';

export function NoticeLine() {
  const { notice } = useTuiStore();
  const theme = useTheme();
  return notice ? <text fg={theme.colors.warning}>{notice}</text> : null;
}

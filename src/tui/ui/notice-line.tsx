import { useTuiStore } from './store';

export function NoticeLine() {
  const { notice } = useTuiStore();
  return notice ? <text fg="yellow">{notice}</text> : null;
}

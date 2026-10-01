import { useTuiStore } from './store';

export function EmptyState({ pendingPrompt, loginCommands }: { pendingPrompt?: string; loginCommands: Record<string, string> }) {
  const { state } = useTuiStore();
  const lines: string[] = [];
  if (state.catalog.length === 0) {
    if (state.probing !== false) {
      lines.push('Checking providers…');
    } else if (state.unavailable.length === 0) {
      lines.push('No provider is enabled. Run `marcode config` to enable one.');
    } else {
      for (const p of state.unavailable) {
        lines.push(`${p.displayName}: ${p.reason}`);
        if (p.id in loginCommands) { lines.push(`  run: marcode login ${p.id}`); }
      }
      lines.push('Press Ctrl+R to check again.');
    }
  } else {
    lines.push('No sessions yet. Press Ctrl+N to start one:');
    for (const p of state.catalog) { lines.push(`  ${p.displayName}`); }
  }
  if (pendingPrompt) { lines.push(`Your prompt is kept: ${pendingPrompt}`); }
  return (
    <box flexDirection="column" padding={1}>
      {lines.map((l, i) => <text key={i} fg={i === 0 ? undefined : 'gray'}>{l}</text>)}
    </box>
  );
}

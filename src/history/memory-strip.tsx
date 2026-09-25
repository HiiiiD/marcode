import { Button } from '@/components/ui/button';
import { useStore } from './store';

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`;

export function MemoryStrip() {
  const { state, post } = useStore();
  const { memory, estimate, progress } = state;
  if (!memory?.enabled) { return null; }

  let body;
  if (progress) {
    const label = progress.phase === 'llm' ? 'Summarizing' : 'Indexing';
    body = (
      <>
        <span aria-live="polite">{`${label} ${progress.done}/${progress.total}`}</span>
        <Button variant="outline" size="sm" onClick={() => post({ t: 'memory-cancel' })}>Stop</Button>
      </>
    );
  } else if (memory.llm && estimate && estimate.sessions > 0) {
    body = (
      <>
        <span>{`Summarize ${estimate.sessions} sessions (~${kTokens(estimate.approxInputTokens)} tokens)?`}</span>
        <Button size="sm" onClick={() => post({ t: 'memory-reindex', scope: estimate.scope })}>Start</Button>
      </>
    );
  } else {
    body = (
      <Button
        variant="outline"
        size="sm"
        onClick={() => post(memory.llm
          ? { t: 'memory-estimate', scope: 'missing-llm' }
          : { t: 'memory-reindex', scope: 'missing-llm' })}
      >
        Index memory
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
      {body}
    </div>
  );
}

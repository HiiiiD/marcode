import type { SessionState } from '../../protocol/messages';

export function SubagentSummary({ subagents }: { subagents: SessionState['subagents'] }) {
  if (!subagents) { return null; }
  const { running, awaitingApproval } = subagents;
  return (
    <span className="shrink-0 text-muted-foreground">
      <span>{running} {running === 1 ? 'subagent' : 'subagents'}</span>
      {awaitingApproval > 0 && <span className="ml-1.5 text-foreground">{awaitingApproval} needs approval</span>}
    </span>
  );
}

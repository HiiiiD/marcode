export function buildSubagentPreamble(o: { parent: string }): string {
  return [
    `You are a subagent: session "${o.parent}" delegated the task below to you.`,
    'Your final reply is returned to it automatically, so do not message it. Finish with a concise result.',
  ].join('\n');
}

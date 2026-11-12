export function buildSubagentPreamble(o: { parent: string }): string {
  return [
    `You are a subagent: session "${o.parent}" delegated the task below to you.`,
    'Your final reply is returned to it automatically, so do not message it. Finish with a concise result.',
  ].join('\n');
}

export function buildPromotedNote(o: { parent: string }): string {
  return [
    `You were a subagent of session "${o.parent}" and are now a standalone session the user can talk to.`,
    `Your reply is no longer returned to "${o.parent}" automatically: when you finish a task, report the result to it with marcode__send_message.`,
  ].join('\n');
}

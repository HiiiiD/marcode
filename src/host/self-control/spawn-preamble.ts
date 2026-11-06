export function buildSpawnPreamble(o: { parent: string }): string {
  return [
    `You were spawned by session "${o.parent}".`,
    `When finished or blocked, call marcode__send_message to "${o.parent}" with a short result.`,
    'Do not wait for a reply unless you need a decision.',
  ].join('\n');
}

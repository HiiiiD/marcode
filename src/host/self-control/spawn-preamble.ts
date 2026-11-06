export function buildSpawnPreamble(o: { parent: string }): string {
  return [
    `You were spawned by session "${o.parent}".`,
    `If you need to report back or ask something, call marcode__send_message to "${o.parent}".`,
  ].join('\n');
}

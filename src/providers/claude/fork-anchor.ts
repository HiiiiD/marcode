export interface AnchorMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  parent_tool_use_id: string | null;
  message: unknown;
}

/** A user message the person typed: not a tool result and not inside a subagent. */
function isPrompt(m: AnchorMessage): boolean {
  if (m.type !== 'user' || m.parent_tool_use_id !== null) { return false; }
  const content = (m.message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') { return true; }
  return Array.isArray(content) && content.some((b) => (b as { type?: string }).type !== 'tool_result');
}

/**
 * The uuid of the last message in the zero-based user turn `turnIndex`, which
 * is what `forkSession({ upToMessageId })` cuts at. `undefined` when the file
 * holds fewer prompts than the host's transcript, so the caller falls back to
 * the seed rather than fork the wrong place.
 */
export function anchorFor(messages: AnchorMessage[], turnIndex: number): string | undefined {
  const starts = messages.flatMap((m, i) => (isPrompt(m) ? [i] : []));
  if (starts.length <= turnIndex) { return undefined; }
  const end = starts[turnIndex + 1] ?? messages.length;
  return messages[end - 1]?.uuid;
}

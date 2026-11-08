export interface AnchorMessage {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  parent_tool_use_id: string | null;
  message: unknown;
}

// The CLI's own bookkeeping, stored as ordinary user messages: the SDK skips them when it counts prompts.
const NOT_A_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

/** A user message the person typed: not a tool result, an interrupt marker or a tag message, and not inside a subagent. */
function isPrompt(m: AnchorMessage): boolean {
  if (m.type !== 'user' || m.parent_tool_use_id !== null) { return false; }
  const content = (m.message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') { return !NOT_A_PROMPT.test(content); }
  if (!Array.isArray(content)) { return false; }
  const blocks = content as { type?: string; text?: string }[];
  if (blocks.every((b) => b.type === 'tool_result')) { return false; }
  const first = blocks.find((b) => b.type === 'text');
  return !(first?.text !== undefined && NOT_A_PROMPT.test(first.text));
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

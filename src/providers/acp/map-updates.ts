import type { AgentEvent, ContextBreakdown, Invocable, ToolCall, ToolOutput } from '../types';

/** One ACP tool call, narrowed to the fields every ACP agent populates. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: { path: string }[];
}

/**
 * The vendor half. `map-updates` decides WHICH events an update produces;
 * the mapper decides what a tool call IS. Keeping them apart is what makes
 * this file reusable by a second ACP agent.
 */
export interface ToolMapper {
  call(c: AcpToolCall): ToolCall;
  output(c: AcpToolCall): ToolOutput;
}

const textOf = (content: unknown): string | undefined => {
  const block = content as { type?: string; text?: string } | undefined;
  return block?.type === 'text' ? block.text ?? '' : undefined;
};

export function toAgentEvents(update: Record<string, unknown>, tools: ToolMapper): AgentEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const delta = textOf(update.content);
      return delta === undefined ? [] : [{ kind: 'text', delta }];
    }
    case 'agent_thought_chunk': {
      const delta = textOf(update.content);
      return delta === undefined ? [] : [{ kind: 'thinking', delta }];
    }
    case 'tool_call': {
      const call = update as unknown as AcpToolCall;
      return [{ kind: 'tool-start', id: call.toolCallId, tool: tools.call(call) }];
    }
    case 'tool_call_update': {
      const call = update as unknown as AcpToolCall;
      if (call.status !== 'completed' && call.status !== 'failed') { return []; }
      // `tool` is re-sent deliberately: opencode's `tool_call` for bash carries
      // no command at all, and only this update has `rawInput.command`.
      return [{
        kind: 'tool-end', id: call.toolCallId, ok: call.status === 'completed',
        output: tools.output(call), tool: tools.call(call),
      }];
    }
    case 'available_commands_update': {
      const raw = (update.availableCommands ?? []) as { name: string; description?: string }[];
      const entries: Invocable[] = raw.map((c) => (
        c.description === undefined ? { name: c.name } : { name: c.name, description: c.description }
      ));
      return [{ kind: 'invocables', entries }];
    }
    // `user_message_chunk` arrives only while a session/load replays history we
    // already hold; `usage_update` feeds contextBreakdown, not the stream.
    // Everything else is a variant this agent version does not send, and an
    // unknown variant must never take a session down.
    default:
      return [];
  }
}

/**
 * OpenCode reports one undifferentiated total, so `systemPercent` and
 * `memoryPercent` are 0 rather than guessed at: inventing a split would put
 * percentages on screen that the provider never reported.
 */
export function toContextBreakdown(update: { used: number; size: number }): ContextBreakdown {
  const size = update.size > 0 ? update.size : 1;
  const used = Math.max(0, Math.min(update.used, size));
  const conversationPercent = Math.round((used / size) * 100);
  return {
    systemPercent: 0,
    memoryPercent: 0,
    conversationPercent,
    freePercent: 100 - conversationPercent,
    memoryFiles: [],
    usedTokens: update.used,
    windowTokens: update.size,
  };
}

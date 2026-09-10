import type { AcpToolCall } from '../acp/map-updates';
import type { ToolCall } from '../types';
import { openCodeTools } from './map-tools';

/**
 * The four `ToolPart`/`ToolState` shapes opencode's own SDK publishes on its
 * global event stream (`@opencode-ai/sdk@1.18.30`, `dist/v2/gen/types.gen.d.ts`
 * — `ToolPart`, `ToolState`). Narrowed to what this file reads: a full
 * `ToolPart` also carries `id`/`sessionID`/`messageID`/`type: 'tool'`, which
 * `subagent-watch.ts` (Task 2) already has and doesn't need repeated here.
 */
export interface RawToolPart {
  callID: string;
  tool: string;
  state:
    | { status: 'pending'; input: Record<string, unknown>; raw: string }
    | {
        status: 'running'; input: Record<string, unknown>; title?: string;
        metadata?: Record<string, unknown>; time: { start: number };
      }
    | {
        status: 'completed'; input: Record<string, unknown>; output: string;
        title: string; metadata: Record<string, unknown>;
        time: { start: number; end: number };
      }
    | {
        status: 'error'; input: Record<string, unknown>; error: string;
        metadata?: Record<string, unknown>; time: { start: number; end: number };
      };
}

/**
 * Mirrors `toToolKind` in opencode's own `packages/opencode/src/acp/tool.ts`
 * exactly — the table that decides which ACP `kind` a tool name gets, and
 * therefore which branch `openCodeTools.call` (`map-tools.ts`) takes. Not
 * importable (it's the vendor's server-side source, not a published
 * package), so it's replicated here verbatim rather than guessed at. Verified
 * 2026-09-10 against `dev` HEAD — see the design doc's research trail.
 */
function toAcpKind(tool: string): string {
  switch (tool.toLocaleLowerCase()) {
    case 'bash':
    case 'shell': return 'execute';
    case 'webfetch': return 'fetch';
    case 'edit':
    case 'apply_patch':
    case 'patch':
    case 'write': return 'edit';
    case 'grep':
    case 'glob':
    case 'context':
    case 'context7_resolve_library_id':
    case 'context7_get_library_docs': return 'search';
    case 'read': return 'read';
    case 'task': return 'think';
    default: return 'other';
  }
}

function statusOf(status: RawToolPart['state']['status']): string {
  if (status === 'running') { return 'in_progress'; }
  if (status === 'error') { return 'failed'; }
  return status;
}

/**
 * A raw `ToolPart` reshaped into the same `AcpToolCall` shape the ACP bridge
 * itself already produces for the root session — so classification lives in
 * exactly one place (`openCodeTools`, `map-tools.ts`), never duplicated here.
 */
export function toolPartToAcpCall(part: RawToolPart): AcpToolCall {
  const { state } = part;
  const title = state.status === 'running' || state.status === 'completed'
    ? state.title : undefined;
  const rawOutput = state.status === 'completed'
    ? { output: state.output, metadata: state.metadata }
    : state.status === 'error'
      ? { error: state.error, metadata: state.metadata }
      : undefined;
  const content = state.status === 'completed'
    ? [{ type: 'content', content: { type: 'text', text: state.output } }]
    : undefined;
  return {
    toolCallId: part.callID,
    title,
    kind: toAcpKind(part.tool),
    status: statusOf(state.status),
    rawInput: state.input,
    ...(rawOutput ? { rawOutput } : {}),
    ...(content ? { content } : {}),
  };
}

export function subagentToolCall(part: RawToolPart): ToolCall {
  return openCodeTools.call(toolPartToAcpCall(part));
}

export function subagentToolOutput(part: RawToolPart): ReturnType<typeof openCodeTools.output> {
  return openCodeTools.output(toolPartToAcpCall(part));
}

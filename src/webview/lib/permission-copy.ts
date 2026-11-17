import { describeTool } from '../../client-core/tool-render';
import type { ToolCall } from '../../providers/canonical/tool-call';

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function editTarget(tool: Extract<ToolCall, { kind: 'file-edit' }>): string {
  return tool.files.length === 1 ? baseName(tool.files[0].path) : `${tool.files.length} files`;
}

/**
 * The question a live approval card asks: the action, not the tool's name.
 * A provider's own `displayName` always wins — it is what its permission
 * engine would have said — and an unrecognised kind falls back to the label.
 */
export function requestTitle(tool: ToolCall, label: string, providerName: boolean): string {
  if (providerName) { return `Allow ${label}?`; }
  switch (tool.kind) {
    case 'command': return 'Run this command?';
    case 'file-edit': return `Edit ${editTarget(tool)}?`;
    case 'mcp': return `Call ${tool.tool}?`;
    default: return `Allow ${label}?`;
  }
}

/** What a settled approval says in the transcript: a sentence about what happened, never the raw tool name. */
export function resolvedText(
  tool: ToolCall, label: string, server: string | undefined, state: 'allowed' | 'denied' | 'pending',
): string {
  if (state === 'pending') { return `${label} — pending`; }
  const ok = state === 'allowed';
  switch (tool.kind) {
    case 'plan': return ok ? 'Plan approved · implementation started' : 'Plan not approved · kept planning';
    case 'command': return `${ok ? 'Ran' : 'Denied'} ${describeTool(tool).primary}`;
    case 'file-edit': return `${ok ? 'Edited' : 'Denied edit of'} ${editTarget(tool)}`;
    case 'mcp': return `${ok ? 'Called' : 'Denied'} ${tool.server ? `${tool.server} · ` : ''}${tool.tool}`;
    default: return `${server ? `${server} ` : ''}${label} — ${state}`;
  }
}

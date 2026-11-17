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
    case 'file-read': return `Read ${baseName(tool.path)}?`;
    case 'mcp': return `Call ${tool.tool}?`;
    default: return `Allow ${label}?`;
  }
}

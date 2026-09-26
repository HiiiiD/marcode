import type { ToolCall } from '../providers/canonical/tool-call';

export interface PermissionRule { key: string; label: string }

const CHAIN = /&&|\|\||[;|`<>&\n\r]|\$\(/;
const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'eval', 'exec', 'xargs', 'bash', 'sh', 'zsh', 'fish', 'pwsh',
  'powershell', 'cmd', 'nohup', 'time',
]);
const SUBCOMMAND = /^[a-z][\w:-]*$/i;

function commandRule(command: string): PermissionRule | undefined {
  if (CHAIN.test(command)) { return undefined; }
  const [first, second, third] = command.trim().split(/\s+/);
  if (!first || first.includes('=') || WRAPPERS.has(first.toLowerCase())) { return undefined; }
  if (second && SUBCOMMAND.test(second)) {
    return { key: `command:${first} ${second}`, label: `Always allow \`${first} ${second}\`` };
  }
  // `ls -la` is fine (flags trail the verb); `git -C x status` hides the verb behind a flag's value.
  if (second?.startsWith('-') && third !== undefined && !third.startsWith('-')) { return undefined; }
  return { key: `command:${first}`, label: `Always allow \`${first}\`` };
}

export function ruleFor(tool: ToolCall): PermissionRule | undefined {
  switch (tool.kind) {
    case 'command':
      return commandRule(tool.command);
    case 'file-edit':
      if (tool.files.length === 0 || tool.files.some((f) => f.op === 'delete' || f.op === 'rename')) {
        return undefined;
      }
      return { key: 'file-edit', label: 'Always allow file edits' };
    case 'mcp':
      return { key: `mcp:${tool.server}:${tool.tool}`, label: `Always allow ${tool.server} ${tool.tool}` };
    default:
      return undefined;
  }
}

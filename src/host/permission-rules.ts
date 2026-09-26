import type { FileEdit, ToolCall } from '../providers/canonical/tool-call';
import { isWithin } from '../shared/path-scope';

export interface PermissionRule { key: string; label: string }

// Anything that can run a second command, expand, redirect or hide a verb.
const UNSAFE = /&&|\|\||[;|`<>&(){}%\n\r]|\$\(/;
const EXEC_FLAG = /^--(pre|output|open-files-in-pager|exec|upload-pack|receive-pack)\b|^-c$/;
const SCRIPT = /^(test|lint|build|compile|typecheck|check-types)(:[\w-]+)?$/;

// An allow-list, not a deny-list: a verb nobody listed (wrappers, interpreters,
// `find -exec`, `rm`) can never earn a rule, whatever spelling it arrives in.
const READ_ONLY = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'which', 'echo', 'date', 'stat', 'file', 'du', 'df']);
const SUBCOMMANDS: Record<string, RegExp> = {
  git: /^(status|diff|log|show|add|commit)$/,
  yarn: SCRIPT,
  npm: SCRIPT,
  pnpm: SCRIPT,
};

// Never auto-approvable: writing these can change what the agent is allowed to do.
const PROTECTED = /(^|\/)(\.git|\.claude|\.codex|\.vscode|\.opencode)(\/|$)|(^|\/)(opencode\.json|\.mcp\.json)$/i;
const ABSOLUTE = /^([a-z]:)?[\\/]/i;
const DOT_DOT = /(^|[\\/])\.\.([\\/]|$)/;

function commandRule(tool: Extract<ToolCall, { kind: 'command' }>): PermissionRule | undefined {
  if (tool.skill || UNSAFE.test(tool.command)) { return undefined; }
  const [first, second, ...rest] = tool.command.trim().split(/\s+/);
  if (!first) { return undefined; }
  const sub = SUBCOMMANDS[first];
  if (sub) {
    if (!second || !sub.test(second) || rest.some((t) => EXEC_FLAG.test(t))) { return undefined; }
    return { key: `command:${first} ${second}`, label: `Always allow \`${first} ${second}\`` };
  }
  if (!READ_ONLY.has(first) || [second, ...rest].some((t) => t !== undefined && EXEC_FLAG.test(t))) {
    return undefined;
  }
  return { key: `command:${first}`, label: `Always allow \`${first}\`` };
}

function editRule(files: FileEdit[], cwd: string, caseInsensitive: boolean): PermissionRule | undefined {
  if (files.length === 0) { return undefined; }
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const ok = files.every((f) => {
    if ((f.op !== 'create' && f.op !== 'modify') || !ABSOLUTE.test(f.path) || DOT_DOT.test(f.path)) { return false; }
    if (!isWithin(cwd, f.path, caseInsensitive)) { return false; }
    return !PROTECTED.test(f.path.replace(/\\/g, '/').slice(root.length));
  });
  return ok ? { key: 'file-edit', label: 'Always allow file edits' } : undefined;
}

export function ruleFor(
  tool: ToolCall, cwd: string, caseInsensitive = process.platform === 'win32',
): PermissionRule | undefined {
  switch (tool.kind) {
    case 'command':
      return commandRule(tool);
    case 'file-edit':
      return editRule(tool.files, cwd, caseInsensitive);
    case 'mcp':
      return { key: `mcp:${tool.server}:${tool.tool}`, label: `Always allow ${tool.server} ${tool.tool}` };
    default:
      return undefined;
  }
}

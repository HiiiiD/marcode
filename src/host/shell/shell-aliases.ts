export interface ShellAlias { command: string; args: string[] }
export type ShellAliasTable = Record<string, ShellAlias>;
export type ResolvedShell =
  | { kind: 'alias'; file: string; args: string[] }
  | { kind: 'bash'; script: string };

export const DEFAULT_SHELL_ALIASES: ShellAliasTable = {
  pwsh: { command: 'pwsh', args: ['-NoProfile', '-Command'] },
  powershell: { command: 'powershell.exe', args: ['-NoProfile', '-Command'] },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseShellAliases(raw: unknown): { aliases: ShellAliasTable; warnings: string[] } {
  const aliases: ShellAliasTable = { ...DEFAULT_SHELL_ALIASES };
  const warnings: string[] = [];
  if (raw === undefined) { return { aliases, warnings }; }
  if (!isObject(raw)) {
    return { aliases, warnings: ['config.json: shell.aliases is not an object; using the defaults.'] };
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (!/^[^\s-]\S*$/.test(name)) { warnings.push(`config.json: shell.aliases name "${name}" is not valid; ignored.`); continue; }
    if (entry === null) { delete aliases[name]; continue; }
    if (!isObject(entry) || typeof entry.command !== 'string' || entry.command.trim() === ''
        || !Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) {
      warnings.push(`config.json: shell.aliases.${name} needs a command and a string-list args; ignored.`);
      continue;
    }
    aliases[name] = { command: entry.command, args: entry.args as string[] };
  }
  return { aliases, warnings };
}

export function resolveShellCommand(line: string, aliases: ShellAliasTable): ResolvedShell {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(line.trim());
  if (m && Object.hasOwn(aliases, m[1])) {
    const alias = aliases[m[1]];
    return { kind: 'alias', file: alias.command, args: [...alias.args, m[2].trim()] };
  }
  return { kind: 'bash', script: line.trim() };
}

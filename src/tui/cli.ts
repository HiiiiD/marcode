export type CliCommand =
  | { kind: 'run'; prompt?: string; forceNew: boolean }
  | { kind: 'login'; provider: string }
  | { kind: 'config' }
  | { kind: 'migrate'; oldDir: string }
  | { kind: 'daemon'; action: 'serve' | 'status' | 'stop'; workspaceDir?: string; roots: string[] }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

const DAEMON_USAGE = 'daemon needs one of --serve --workspace-dir <dir> [--root <dir>]..., --status or --stop';

function parseDaemon(args: string[]): CliCommand {
  let action: 'serve' | 'status' | 'stop' | undefined;
  let workspaceDir: string | undefined;
  const roots: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--serve' || arg === '--status' || arg === '--stop') {
      if (action) { return { kind: 'error', message: DAEMON_USAGE }; }
      action = arg === '--serve' ? 'serve' : arg === '--status' ? 'status' : 'stop';
    } else if (arg === '--workspace-dir' || arg === '--root') {
      const value = args[++i];
      if (value === undefined) { return { kind: 'error', message: `${arg} needs a directory` }; }
      if (arg === '--root') { roots.push(value); } else { workspaceDir = value; }
    } else {
      return { kind: 'error', message: `unknown daemon option ${arg}` };
    }
  }
  if (!action) { return { kind: 'error', message: DAEMON_USAGE }; }
  if (action === 'serve' && !workspaceDir) { return { kind: 'error', message: 'daemon --serve needs --workspace-dir' }; }
  return workspaceDir ? { kind: 'daemon', action, workspaceDir, roots } : { kind: 'daemon', action, roots };
}

export const USAGE = [
  'marcode [--new] [prompt...]   open the TUI (resume the last session; with a prompt, start one)',
  'marcode login <provider>      sign a provider in',
  'marcode config                open ~/.marcode/config.json in $EDITOR',
  'marcode migrate <old-dir>     import a VS Code storage folder',
  'marcode daemon --status|--stop   show or stop this workspace\'s background host',
  'marcode -- <prompt...>        a prompt that starts with a subcommand word',
].join('\n');

export function parseArgs(argv: string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === '--help' || first === '-h') { return { kind: 'help' }; }
  if (first === 'login') {
    return rest[0] ? { kind: 'login', provider: rest[0] } : { kind: 'error', message: 'login needs a provider id' };
  }
  if (first === 'config') { return { kind: 'config' }; }
  if (first === 'migrate') {
    return rest[0] ? { kind: 'migrate', oldDir: rest[0] } : { kind: 'error', message: 'migrate needs the old storage directory' };
  }
  if (first === 'daemon') { return parseDaemon(rest); }
  let forceNew = false;
  const words: string[] = [];
  let literal = false;
  for (const arg of argv) {
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg === '--new') { forceNew = true; continue; }
    if (!literal && arg.startsWith('-')) { return { kind: 'error', message: `unknown option ${arg}` }; }
    words.push(arg);
  }
  const prompt = words.join(' ').trim();
  return prompt ? { kind: 'run', prompt, forceNew } : { kind: 'run', forceNew };
}

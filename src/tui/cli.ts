export type CliCommand =
  | { kind: 'run'; prompt?: string; forceNew: boolean }
  | { kind: 'login'; provider: string }
  | { kind: 'config' }
  | { kind: 'migrate'; oldDir: string }
  | { kind: 'daemon'; action: 'serve' | 'status' | 'stop'; workspaceDir?: string; roots: string[] }
  | { kind: 'sync-server'; args: string[] }
  | { kind: 'sync'; action: SyncAction; args: string[] }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export type SyncAction = 'setup' | 'join' | 'pair' | 'devices' | 'revoke' | 'status' | 'leave';
const SYNC_OPERANDS: Record<SyncAction, number> = { setup: 2, join: 2, pair: 0, devices: 0, revoke: 1, status: 0, leave: 0 };
const SYNC_USAGE = 'sync needs one of: setup <url> <bootstrap-code>, join <url> <pairing-code>, pair, devices, revoke <device-id>, status, leave';

function parseSync(args: string[]): CliCommand {
  const [action, ...rest] = args;
  if (!action || !(action in SYNC_OPERANDS)) { return { kind: 'error', message: SYNC_USAGE }; }
  const operands = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--name');
  if (operands.length < SYNC_OPERANDS[action as SyncAction]) { return { kind: 'error', message: SYNC_USAGE }; }
  return { kind: 'sync', action: action as SyncAction, args: rest };
}

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
  'marcode sync setup|join|pair|devices|revoke|status|leave   pair this machine with your sync server (docs/sync.md)',
  'marcode sync-server [--data dir] [--port 8787] [--host 127.0.0.1]   run your own sync server',
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
  if (first === 'sync') { return parseSync(rest); }
  if (first === 'sync-server') { return { kind: 'sync-server', args: rest }; }
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

export type CliCommand =
  | { kind: 'run'; prompt?: string; forceNew: boolean }
  | { kind: 'login'; provider: string }
  | { kind: 'config' }
  | { kind: 'migrate'; oldDir: string }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export const USAGE = [
  'marcode [--new] [prompt...]   open the TUI (resume the last session; with a prompt, start one)',
  'marcode login <provider>      sign a provider in',
  'marcode config                open ~/.marcode/config.json in $EDITOR',
  'marcode migrate <old-dir>     import a VS Code storage folder',
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

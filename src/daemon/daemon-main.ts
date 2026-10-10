import { parseArgs, USAGE } from '../tui/cli';
import { scrubDaemonEnv } from './daemon-env';
import { runDaemonCommand } from '../tui/subcommands';

/** JSX-free `marcode daemon …` entry, loadable by plain Node (the extension's bundle) as well as Bun. */
async function main(): Promise<void> {
  scrubDaemonEnv();
  const cmd = parseArgs(process.argv.slice(2));
  if (cmd.kind !== 'daemon') {
    console.error(`marcode: this entry only runs \`marcode daemon …\`\n${USAGE}`);
    process.exit(2);
  }
  try {
    process.exitCode = await runDaemonCommand(cmd, process.cwd());
  } catch (err) {
    console.error(`marcode: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  // A stopped daemon's provider children or timers must not keep the process alive.
  if (cmd.action === 'serve') { process.exit(process.exitCode ?? 0); }
}

void main();

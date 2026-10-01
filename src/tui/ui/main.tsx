import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { watchConfig } from '../../host/config-file';
import { bootHost, type Booted } from '../boot';
import { parseArgs, USAGE, type CliCommand } from '../cli';
import { createShutdown } from '../shutdown';
import { runConfig, runLogin, runMigrate } from '../subcommands';
import { App } from './app';
import { TuiStoreProvider } from './store';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function runSubcommand(cmd: CliCommand): Promise<number | undefined> {
  switch (cmd.kind) {
    case 'help': console.log(USAGE); return 0;
    case 'error': console.error(`marcode: ${cmd.message}\n${USAGE}`); return 2;
    case 'login': return runLogin(cmd.provider, process.cwd());
    case 'config': return runConfig();
    case 'migrate': return runMigrate(cmd.oldDir, process.cwd());
    case 'run': return undefined;
  }
}

function noticeBridge() {
  let sink: ((text: string) => void) | undefined;
  const queued: string[] = [];
  return {
    notify: (text: string) => { if (sink) { sink(text); } else { queued.push(text); } },
    subscribe: (cb: (text: string) => void) => {
      sink = cb;
      for (const text of queued.splice(0)) { cb(text); }
      return () => { if (sink === cb) { sink = undefined; } };
    },
  };
}

async function runTui(cmd: Extract<CliCommand, { kind: 'run' }>): Promise<void> {
  const notices = noticeBridge();
  let booting = true;
  let booted: Booted;
  try {
    // Boot-time warnings are already in booted.warnings; later ones go to the notice line, never to a live terminal.
    booted = await bootHost({ cwd: process.cwd(), notify: (m) => { if (!booting) { notices.notify(m); } } });
  } catch (err) {
    console.error(`marcode: ${message(err)}`);
    process.exitCode = 1;
    return;
  }
  booting = false;

  const watcher = watchConfig(booted.configFile, booted.fileConfig, () => {
    notices.notify('config.json changed — restart to apply');
  });
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer({ exitOnCtrlC: false });
  } catch (err) {
    watcher.dispose();
    await booted.shutdown().catch(() => {});
    console.error(`marcode: ${message(err)}`);
    process.exitCode = 1;
    return;
  }
  let fatal: string | undefined;
  const shutdown = createShutdown({
    destroyRenderer: () => { renderer.destroy(); },
    disposeHost: () => { watcher.dispose(); return booted.shutdown(); },
    exit: (code) => {
      if (fatal) { console.error(`marcode: ${fatal}`); }
      process.exit(code);
    },
  });
  const crash = (err: unknown) => {
    fatal ??= err instanceof Error ? err.stack ?? err.message : String(err);
    void shutdown(1);
  };
  process.on('SIGINT', () => { void shutdown(130); });
  process.on('SIGTERM', () => { void shutdown(143); });
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  const loginCommands = Object.fromEntries([...booted.host.loginRecipes].map(([id, r]) => [id, r.command]));
  createRoot(renderer).render(
    <TuiStoreProvider transport={booted.loopback.transport}>
      <App
        launchCwd={booted.launchCwd}
        prompt={cmd.prompt}
        forceNew={cmd.forceNew}
        loginCommands={loginCommands}
        initialNotice={booted.warnings[0]}
        subscribeNotices={notices.subscribe}
        onQuit={() => { void shutdown(0); }}
      />
    </TuiStoreProvider>,
  );
}

async function main(): Promise<void> {
  const cmd = parseArgs(process.argv.slice(2));
  if (cmd.kind === 'run') { await runTui(cmd); return; }
  try {
    process.exitCode = await runSubcommand(cmd);
  } catch (err) {
    console.error(`marcode: ${message(err)}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`marcode: ${message(err)}`);
  process.exit(1);
});

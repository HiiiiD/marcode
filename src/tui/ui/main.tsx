import { createCliRenderer, type CliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import type { ClientStatus } from '../../daemon-client/daemon-client';
import { watchConfig } from '../../host/config-file';
import { bootHost, configChangedNotice, type Booted } from '../boot';
import { parseArgs, USAGE, type CliCommand } from '../cli';
import { createShutdown, installExitSignals } from '../shutdown';
import { runConfig, runDaemonCommand, runLogin, runMigrate } from '../subcommands';
import { App } from './app';
import { TuiStoreProvider } from './store';
import { detectTokens } from './tokens/detect-tokens';
import { DetectedTokensProvider } from './tokens/tokens-provider';
import { TuiThemeProvider } from './tui-theme';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// The client only reports `connected` after a reconnect, never at first attach.
const STATUS_NOTICE: Record<ClientStatus, string> = {
  reconnecting: 'Reconnecting to the background host…',
  lost: 'Lost the background host; restart marcode',
  connected: 'Reconnected to the background host',
};

async function runSubcommand(cmd: CliCommand): Promise<number | undefined> {
  switch (cmd.kind) {
    case 'help': console.log(USAGE); return 0;
    case 'error': console.error(`marcode: ${cmd.message}\n${USAGE}`); return 2;
    case 'login': return runLogin(cmd.provider, process.cwd());
    case 'config': return runConfig();
    case 'migrate': return runMigrate(cmd.oldDir, process.cwd());
    case 'daemon': return runDaemonCommand(cmd, process.cwd());
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
    // A host that got partway up can hold timers or sockets open; nothing here is worth waiting for.
    process.exit(1);
  }
  booting = false;
  booted.onStatus((s) => { notices.notify(STATUS_NOTICE[s]); });

  const watcher = watchConfig(booted.configFile, booted.fileConfig, () => {
    notices.notify(configChangedNotice(booted.mode));
  });
  let renderer: CliRenderer | undefined;
  let fatal: string | undefined;
  const shutdown = createShutdown({
    destroyRenderer: () => { renderer?.destroy(); },
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
  installExitSignals((signal, handler) => { process.on(signal, handler); }, shutdown);
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  try {
    // OpenTUI's own exitSignals handler only destroys the renderer and swallows the signal, so the host
    // (leases, self-control server, provider children) would outlive the terminal; we own every signal instead.
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      onDestroy: () => { void shutdown.ifIdle(1); },
    });
  } catch (err) {
    fatal = message(err);
    await shutdown(1);
    return;
  }

  const live = renderer;
  const detect = () => detectTokens(live);
  const loginCommands = Object.fromEntries([...booted.loginRecipes].map(([id, r]) => [id, r.command]));
  createRoot(renderer).render(
    <DetectedTokensProvider detect={detect}>
      <TuiThemeProvider>
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
        </TuiStoreProvider>
      </TuiThemeProvider>
    </DetectedTokensProvider>,
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
  // A stopped daemon's provider children or timers must not keep the process alive.
  if (cmd.kind === 'daemon' && cmd.action === 'serve') { process.exit(process.exitCode ?? 0); }
}

main().catch((err: unknown) => {
  console.error(`marcode: ${message(err)}`);
  process.exit(1);
});

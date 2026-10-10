/**
 * The extension starts the daemon as `ELECTRON_RUN_AS_NODE=1 Code.exe daemon.js`. Left set, every agent shell
 * the daemon spawns inherits it and Electron apps (including a test run that launches VS Code) start as plain Node.
 */
export function scrubDaemonEnv(env: NodeJS.ProcessEnv = process.env): void {
  delete env.ELECTRON_RUN_AS_NODE;
}

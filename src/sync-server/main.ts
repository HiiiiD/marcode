import { runSyncServer } from './run';

// JSX-free entry so plain Node (and the Docker image) can run the server without the TUI bundle.
void runSyncServer(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) })
  .then((code) => process.exit(code));

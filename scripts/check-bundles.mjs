// A dependency whose UMD entry hides relative require()s from esbuild builds
// fine and then dies on load ("Cannot find module './impl/format'"), which no
// source-level test sees. This loads each host bundle for real.
import { spawnSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = false;
const fail = (bundle, why) => { failed = true; console.error(`FAIL ${bundle}: ${why}`); };

// The extension bundle only defines activate/deactivate on load, so it can be required in-process.
const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub, construct: () => stub });
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : load.call(this, request, ...rest);
};
try {
  const ext = require(path.join(root, 'dist/extension.js'));
  if (typeof ext.activate === 'function') { console.log('ok   dist/extension.js'); } else { fail('dist/extension.js', 'no activate export'); }
} catch (err) {
  fail('dist/extension.js', err instanceof Error ? err.message.split('\n')[0] : String(err));
}

// The daemon runs on load; with no `daemon` subcommand it loads its whole graph, prints usage and exits 2.
const daemon = spawnSync(process.execPath, [path.join(root, 'dist/daemon.js')], { encoding: 'utf8', timeout: 30_000 });
if (daemon.status === 2 && daemon.stderr.includes('this entry only runs')) {
  console.log('ok   dist/daemon.js');
} else {
  fail('dist/daemon.js', `exit ${daemon.status}: ${(daemon.stderr || daemon.stdout).trim().split('\n')[0]}`);
}
process.exit(failed ? 1 : 0);

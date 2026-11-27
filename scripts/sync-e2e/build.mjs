// Bundles the device driver for Linux containers: plain Node, no native modules (SQLite is node:sqlite).
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await esbuild.build({
  entryPoints: [path.join(root, 'scripts/sync-e2e/driver.ts')],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outfile: path.join(root, 'scripts/sync-e2e/out/driver.js'),
  external: ['bun:sqlite', '@anthropic-ai/claude-agent-sdk'],
  alias: { 'jsonc-parser': path.join(root, 'node_modules/jsonc-parser/lib/esm/main.js') },
  logLevel: 'warning',
});
console.log('built scripts/sync-e2e/out/driver.js');

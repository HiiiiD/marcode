// usage: node scripts/build-tui.mjs [--compile]   (re-runs itself under Bun)
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const compile = process.argv.includes('--compile');
const win = process.platform === 'win32';

if (!process.versions.bun) {
  const res = spawnSync(win ? 'bun.exe' : 'bun', [import.meta.filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: false,
  });
  process.exit(res.status ?? 1);
}

// Bun hoists the lazy require of the sqlite driver into a top-level `import 'node:sqlite'`, which
// Bun's runtime cannot satisfy. The driver opens bun:sqlite under Bun and never constructs this stand-in.
const sqliteStub = {
  name: 'node-sqlite-stub',
  setup(build) {
    build.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: 'node-sqlite', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: "export class DatabaseSync { constructor() { throw new Error('node:sqlite is unavailable under Bun'); } }",
      loader: 'js',
    }));
  },
};

const result = await Bun.build({
  entrypoints: ['src/tui/ui/main.tsx'],
  target: 'bun',
  plugins: [sqliteStub],
  // Pin the host platform so the OpenTUI native packages for other platforms (not installed) are
  // dropped, and DEV=false so the optional react-devtools-core import is dropped.
  define: {
    'process.platform': JSON.stringify(process.platform),
    'process.arch': JSON.stringify(process.arch),
    'process.env.DEV': '"false"',
    ...(process.platform === 'linux' ? { 'process.env.OPENTUI_LIBC': '"glibc"' } : {}),
  },
  ...(compile
    ? { compile: { outfile: win ? 'bin/marcode.exe' : 'bin/marcode' } }
    : { outdir: 'dist/tui', naming: { entry: 'tui.js' }, publicPath: pathToFileURL(resolve('dist/tui') + '/').href }),
});

for (const log of result.logs) console.error(String(log));
if (!result.success) process.exit(1);
for (const out of result.outputs) console.log(out.path);

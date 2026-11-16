// Builds .ui-harness/fixture.json from a real workspace dir: index, catalog, usage, transcript tails.
// Output holds private transcripts; .ui-harness is gitignored.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Same match the host uses: workspace.json's `path` is the normalized workspace path.
async function findWorkspaceDir() {
  const root = join(process.env.MARCODE_HOME || join(homedir(), '.marcode'), 'workspaces');
  let want = resolve(process.cwd()).replace(/\\/g, '/');
  if (process.platform === 'win32' || process.platform === 'darwin') want = want.toLowerCase();
  for (const name of await readdir(root)) {
    const meta = await readFile(join(root, name, 'workspace.json'), 'utf8').catch(() => '');
    if (meta && JSON.parse(meta).path === want) return join(root, name);
  }
  throw new Error(`no Marcode workspace dir for ${want} under ${root}; pass one as argv[2]`);
}

const dir = process.argv[2] ?? await findWorkspaceDir();
const tailLimit = Number(process.argv[3] ?? 60);
const json = async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'));

const index = await json('index.json');
const catalogFile = await json('catalog.json');
const usageFile = await json('usage.json').catch(() => ({ providers: {} }));

const modes = [
  { id: 'default' }, { id: 'acceptEdits' }, { id: 'plan' }, { id: 'auto', default: true }, { id: 'bypass' },
];
const catalog = Object.entries(catalogFile.providers)
  .filter(([, models]) => models.length)
  .map(([id, models]) => ({ id, displayName: id, models, permissionModes: modes }));

const sessions = [];
const snapshots = {};
for (const s of index.sessions) {
  const raw = await readFile(join(dir, 'sessions', `${s.id}.jsonl`), 'utf8').catch(() => '');
  const items = raw.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const tail = items.slice(-tailLimit);
  sessions.push({ ...s, open: false });
  snapshots[s.id] = {
    ...s, open: true, items: tail, hasMore: items.length > tail.length,
    pending: [], pendingQuestions: [], mcpServers: [], pendingAttachments: [],
  };
}

await mkdir('.ui-harness', { recursive: true });
await writeFile('.ui-harness/fixture.json', JSON.stringify({ sessions, snapshots, catalog, usage: usageFile.providers }));
console.log(`sessions=${sessions.length} providers=${catalog.map((c) => c.id).join(',')}`);

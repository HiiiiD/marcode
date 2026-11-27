// One "device" for the Docker sync test: a real host (createHost, fake provider) in its own container,
// with its own ~/.marcode and git checkout, driven over a tiny HTTP API by run.mjs on the host machine.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../src/host/create-host';
import { defaultHostConfig } from '../../src/host/host-config';
import { resolveWorkspaceDir } from '../../src/host/workspace-dir';
import type { HostToWebview, MoveStatus } from '../../src/protocol/messages';
import { readCredentials, writeCredentials } from '../../src/sync/credentials';
import { SyncClient } from '../../src/sync/sync-client';

const HOME = process.env.MARCODE_HOME ?? '/data/marcode';
const REPO = process.env.REPO ?? '/data/repo';
const NAME = process.env.DEVICE_NAME ?? 'device';
const PORT = Number(process.env.PORT ?? 7000);

let host: HostHandle | undefined;
const sent: HostToWebview[] = [];
const moves = new Map<string, MoveStatus[]>();

async function ensureRepo(): Promise<void> {
  if (await fs.stat(path.join(REPO, '.git')).then(() => true, () => false)) { return; }
  await fs.mkdir(REPO, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@x', '-c', 'user.name=e2e', ...args], { cwd: REPO, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:marcode-e2e/demo.git');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  // "Pushed" without a network: the upstream ref is HEAD, which is what the move check reads.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('branch', '--set-upstream-to=origin/main');
}

async function start(): Promise<void> {
  if (host) { return; }
  await ensureRepo();
  const config = defaultHostConfig();
  host = await createHost({
    workspaceDir: await resolveWorkspaceDir(HOME, REPO), hostKind: 'tui', workspaceRoots: () => [REPO],
    emit: (m) => { sent.push(m); if (sent.length > 5000) { sent.splice(0, 1000); } }, notify: { warn: (w) => { console.warn('[warn]', w); } },
    marcodeHome: HOME, pollMs: 500,
    config: { ...config, enabledProviders: ['fake'], sync: { ...config.sync, takeOverAfterMinutes: 1 } },
  });
  await host.init();
}

const until = async (done: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await done()) { return true; } await new Promise((r) => setTimeout(r, 200)); }
  return false;
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) { text += String(chunk); }
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

type Handler = (b: Record<string, unknown>, q: URLSearchParams) => Promise<unknown>;
const need = (): HostHandle => { if (!host) { throw new Error('host not started'); } return host; };
const routes: Record<string, Handler> = {
  'POST /enroll': async (b) => {
    const r = await SyncClient.enroll(String(b.server), String(b.code), NAME);
    if (!r.ok) { throw new Error(r.error); }
    await writeCredentials(HOME, r.value);
    return { deviceId: r.value.deviceId };
  },
  'POST /pair': async () => {
    const r = await new SyncClient((await readCredentials(HOME))!).createPairing();
    if (!r.ok) { throw new Error(r.error); }
    return { code: r.value.code };
  },
  'POST /join': async (b) => {
    const r = await SyncClient.join(String(b.server), String(b.code), NAME);
    if (!r.ok) { throw new Error(r.error); }
    await writeCredentials(HOME, r.value);
    return { deviceId: r.value.deviceId };
  },
  'POST /start': async () => { await start(); return { ok: true }; },
  'GET /health': async () => ({ name: NAME, started: host !== undefined }),
  'POST /session': async (b) => {
    const s = await need().manager.create('fake', REPO);
    s.send(String(b.text ?? 'hello'));
    await until(() => s.state.status === 'idle', 10_000);
    return { id: s.state.id };
  },
  'POST /send': async (b) => {
    const s = await need().manager.open(String(b.id));
    s.send(String(b.text));
    await until(() => s.state.status === 'idle', 10_000);
    return { status: s.state.status };
  },
  'POST /close': async (b) => { await need().manager.close(String(b.id)); return { ok: true }; },
  'POST /delete': async (b) => { await need().manager.remove(String(b.id)); return { ok: true }; },
  'GET /sessions': async () => need().manager.summaries().map((s) => ({
    id: s.id, title: s.title, status: s.status, cwd: s.cwd, remote: s.remote, origin: s.origin, parentId: s.parentId,
  })),
  'GET /items': async (_b, q) => {
    const id = q.get('id')!;
    const m = need().manager;
    if (m.isRemote(id)) {
      await m.setVisible([...new Set([...m.visibleIds(), id])]);
      const s = await m.open(id);
      return (await s.snapshot()).items.map((i) => ({ id: i.id, role: i.role, text: 'text' in i ? i.text : undefined }));
    }
    return (await need().store.tail(id, 1000)).items.map((i) => ({ id: i.id, role: i.role, text: 'text' in i ? i.text : undefined }));
  },
  'GET /recall': async (_b, q) => {
    const h = need();
    const scope = await h.manager.recallScopeOf(REPO);
    return ((await h.memory?.search(q.get('q') ?? '', { ...scope, match: 'any' })) ?? []).map((x) => x.sessionId);
  },
  'GET /panel': async (_b, q) => need().manager.moveService?.panel(q.get('id')!),
  'POST /move': async (b) => {
    const id = String(b.id);
    moves.set(id, []);
    const svc = need().manager.moveService!;
    const report = (s: MoveStatus) => { moves.get(id)!.push(s); };
    const work = b.takeOver ? svc.takeOver(id, { root: REPO }, report) : svc.moveHere(id, { root: REPO }, { cancelTurn: false }, report);
    void work;
    return { started: true };
  },
  'GET /move': async (_b, q) => moves.get(q.get('id')!) ?? [],
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) { res.writeHead(404).end(); return; }
  body(req).then((b) => handler(b, url.searchParams)).then(
    (out) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? null)); },
    (err: unknown) => { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) })); },
  );
}).listen(PORT, '0.0.0.0', () => { console.log(`[${NAME}] driver on :${PORT}`); });

// A restarted container picks up where it was: already paired means start the host at once.
void readCredentials(HOME).then((creds) => { if (creds) { void start(); } });

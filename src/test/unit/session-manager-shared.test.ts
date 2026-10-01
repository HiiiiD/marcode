import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../../host/session-manager';
import { defaultLeaseDeps } from '../../host/lease';
import { SessionOwnership } from '../../host/session-ownership';
import { TranscriptStore } from '../../host/transcript-store';
import type { HostToWebview } from '../../protocol/messages';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider } from '../../providers/types';

interface Host { manager: SessionManager; ownership: SessionOwnership; sent: HostToWebview[]; store: TranscriptStore }

const settle = () => new Promise((r) => setTimeout(r, 60));

suite('SessionManager (shared directory)', () => {
  let dir: string;
  const hosts: Host[] = [];

  async function host(kind: 'vscode' | 'tui'): Promise<Host> {
    const store = new TranscriptStore(dir, kind);
    const sent: HostToWebview[] = [];
    const providers = new Map<string, AgentProvider>([
      ['fake', new FakeProvider(() => [{ kind: 'text', delta: 'ok' }, { kind: 'turn-end', reason: 'done' }])],
    ]);
    const manager = new SessionManager(store, providers, (m) => sent.push(m));
    const ownership = new SessionOwnership(path.join(dir, 'sessions'), kind, { heartbeatMs: 20 });
    manager.setOwnership(ownership, { tailIntervalMs: 20 });
    await manager.init();
    const h = { manager, ownership, sent, store };
    hosts.push(h);
    return h;
  }

  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-shared-')); });
  teardown(async () => {
    for (const h of hosts.splice(0)) { await h.manager.dispose(); await h.ownership.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function ownedSession(owner: Host) {
    const session = await owner.manager.create('fake', '/w');
    session.send('hi');
    await settle();
    await owner.manager.persistNow();
    return session;
  }

  test('a session owned by one host opens read-only on the other and carries the owner', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    const opened = await guest.manager.open(session.state.id);
    assert.deepStrictEqual(opened.state.owner, { host: 'vscode', pid: process.pid });
  });

  test('sending to a foreign session changes nothing on disk', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const file = path.join(dir, 'sessions', `${session.state.id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');

    const guest = await host('tui');
    await guest.manager.syncRoster();
    const foreign = await guest.manager.open(session.state.id);
    foreign.send('should not land');
    await settle();
    await guest.store.flush();
    assert.strictEqual(await fs.readFile(file, 'utf8'), before);
  });

  test('deleting a foreign session is refused and its transcript survives', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await guest.manager.open(session.state.id);
    await guest.manager.remove(session.state.id);
    await fs.access(path.join(dir, 'sessions', `${session.state.id}.jsonl`));
  });

  test('once the owner lets go, the guest can take the session over', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await guest.manager.open(session.state.id);

    await owner.manager.close(session.state.id);
    const taken = await guest.manager.open(session.state.id);
    assert.strictEqual(taken.state.owner, undefined);
  });

  test('a new session made on one host appears on the other after a sync', async () => {
    const a = await host('vscode');
    const b = await host('tui');
    const made = await a.manager.create('fake', '/w');
    await a.manager.persistNow();
    await b.manager.syncRoster();
    assert.strictEqual(b.manager.summaries().some((x) => x.id === made.state.id), true);
  });

  test('a roster sync racing a persist never drops a session that was just created', async () => {
    const a = await host('vscode');
    const made = await a.manager.create('fake', '/w');
    await Promise.all([a.manager.persistNow(), a.manager.syncRoster(), a.manager.syncRoster()]);
    assert.strictEqual(a.manager.summaries().some((x) => x.id === made.state.id), true);
  });

  const indexFile = () => path.join(dir, 'index.json');
  const indexIds = async () => (JSON.parse(await fs.readFile(indexFile(), 'utf8')) as { sessions: { id: string }[] }).sessions.map((s) => s.id);
  const listed = (h: Host, id: string) => h.manager.summaries().some((x) => x.id === id);

  test('a deleted session stays deleted across persists and syncs', async () => {
    const a = await host('vscode');
    const made = await a.manager.create('fake', '/w');
    made.send('hi');
    await settle();
    await a.manager.persistNow();
    await a.manager.remove(made.state.id);
    await a.manager.persistNow();
    await a.manager.syncRoster();
    await a.manager.persistNow();
    assert.strictEqual(listed(a, made.state.id), false);
    assert.strictEqual((await indexIds()).includes(made.state.id), false);
  });

  test('a guest cannot delete, discard or close away a session another host is running', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const untitled = await owner.manager.create('fake', '/w');
    await owner.manager.persistNow();
    const file = path.join(dir, 'sessions', `${session.state.id}.jsonl`);
    const guest = await host('tui');
    await guest.manager.syncRoster();

    await guest.manager.remove(session.state.id);
    await guest.manager.close(untitled.state.id);
    await guest.manager.persistNow();
    await owner.manager.syncRoster();
    await owner.manager.persistNow();

    await fs.access(file);
    assert.strictEqual(listed(guest, session.state.id), true);
    assert.strictEqual(listed(guest, untitled.state.id), true);
    assert.deepStrictEqual((await indexIds()).includes(session.state.id) && (await indexIds()).includes(untitled.state.id), true);
    assert.strictEqual(listed(owner, untitled.state.id), true);
  });

  test('a guest hiding a revealed foreign session never discards it', async () => {
    const owner = await host('vscode');
    const untitled = await owner.manager.create('fake', '/w');
    await owner.manager.persistNow();
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await guest.manager.setVisible([untitled.state.id]);
    await guest.manager.setVisible([]);
    await guest.manager.persistNow();
    assert.strictEqual(listed(guest, untitled.state.id), true);
    assert.strictEqual((await indexIds()).includes(untitled.state.id), true);
  });

  test('a session this host owns survives an index write that lost it', async () => {
    const a = await host('vscode');
    const made = await a.manager.create('fake', '/w');
    await a.manager.persistNow();
    const raw = JSON.parse(await fs.readFile(indexFile(), 'utf8')) as { sessions: unknown[] };
    await fs.writeFile(indexFile(), JSON.stringify({ ...raw, sessions: [] }));
    await a.manager.syncRoster();
    assert.strictEqual(listed(a, made.state.id), true);
    await a.manager.persistNow();
    assert.strictEqual((await indexIds()).includes(made.state.id), true);
  });

  test('an index at a newer version is neither synced from nor overwritten', async () => {
    const a = await host('vscode');
    const made = await a.manager.create('fake', '/w');
    await a.manager.persistNow();
    const newer = JSON.stringify({ version: 3, sessions: [], layout: {} });
    await fs.writeFile(indexFile(), newer);
    await a.manager.syncRoster();
    await a.manager.persistNow();
    assert.strictEqual(listed(a, made.state.id), true);
    assert.strictEqual(await fs.readFile(indexFile(), 'utf8'), newer);
  });

  test('a deleted index.json is not read as every session deleted elsewhere', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await fs.rm(indexFile());
    await guest.manager.syncRoster();
    assert.strictEqual(listed(guest, session.state.id), true);
  });

  test('reopening a session another host ran meanwhile keeps that host\'s turn on disk', async () => {
    const texts = ['first', 'second'];
    let turn = 0;
    const scripted = () => [{ kind: 'text' as const, delta: texts[turn++] }, { kind: 'turn-end' as const, reason: 'done' as const }];
    async function scriptedHost(kind: 'vscode' | 'tui'): Promise<Host> {
      const store = new TranscriptStore(dir, kind);
      const sent: HostToWebview[] = [];
      const manager = new SessionManager(store, new Map<string, AgentProvider>([['fake', new FakeProvider(scripted)]]), (m) => sent.push(m));
      const ownership = new SessionOwnership(path.join(dir, 'sessions'), kind, { heartbeatMs: 20 });
      manager.setOwnership(ownership, { tailIntervalMs: 20 });
      await manager.init();
      const h = { manager, ownership, sent, store };
      hosts.push(h);
      return h;
    }
    const a = await scriptedHost('vscode');
    const b = await scriptedHost('tui');
    const s = await a.manager.create('fake', '/w');
    const id = s.state.id;
    s.send('one');
    await settle();
    await a.manager.persistNow();
    await a.manager.setVisible([id]);
    await a.manager.close(id);

    await b.manager.syncRoster();
    const onB = await b.manager.open(id);
    onB.send('two');
    await settle();
    await b.manager.close(id);

    await a.manager.open(id);
    const flushed = (await a.store.tail(id)).items[0];
    a.store.replace(id, { ...flushed });
    await a.manager.persistNow();
    const disk = await fs.readFile(path.join(dir, 'sessions', `${id}.jsonl`), 'utf8');
    assert.deepStrictEqual(texts.map((t) => disk.includes(t)), [true, true]);
  });

  test('a roster change absorbed by a persist is announced to the webview', async () => {
    const guest = await host('tui');
    const owner = await host('vscode');
    const made = await owner.manager.create('fake', '/w');
    await owner.manager.persistNow();
    guest.sent.length = 0;
    await guest.manager.persistNow();
    const announced = guest.sent.some((m) => m.t === 'sessions-changed' && m.sessions.some((x) => x.id === made.state.id));
    assert.strictEqual(announced, true);
  });

  test('a foreign session revealed in a pane follows the owner\'s turns', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    await guest.manager.setVisible([session.state.id]);
    guest.sent.length = 0;
    session.send('again');
    await settle();
    await owner.manager.persistNow();
    await settle();
    assert.strictEqual(guest.sent.some((m) => m.t === 'session-patch' && m.id === session.state.id), true);
  });

  test('concurrent opens of one session build it once', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    const [x, y] = await Promise.all([guest.manager.open(session.state.id), guest.manager.open(session.state.id)]);
    assert.strictEqual(x === y, true);

    await owner.manager.close(session.state.id);
    const free = await owner.manager.create('fake', '/w');
    await owner.manager.close(free.state.id);
    const [p, q] = await Promise.all([owner.manager.open(session.state.id), owner.manager.open(session.state.id)]);
    assert.strictEqual(p === q, true);
  });

  test('a row left running by an owner that went away reads idle', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const raw = JSON.parse(await fs.readFile(indexFile(), 'utf8')) as { sessions: { status: string }[] };
    raw.sessions[0].status = 'running';
    await fs.writeFile(indexFile(), JSON.stringify(raw));
    const guest = await host('tui');
    await guest.manager.syncRoster();
    assert.strictEqual(guest.manager.summaries().find((x) => x.id === session.state.id)?.status, 'running');
    await owner.ownership.release(session.state.id);
    await guest.manager.syncRoster();
    const row = guest.manager.summaries().find((x) => x.id === session.state.id);
    assert.deepStrictEqual([row?.status, row?.owner], ['idle', undefined]);
  });

  test('an unreadable lock opens the session read-only with an error, never taking it over', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const store = new TranscriptStore(dir, 'tui');
    const sent: HostToWebview[] = [];
    const manager = new SessionManager(store, new Map<string, AgentProvider>([['fake', new FakeProvider(() => [])]]), (m) => sent.push(m));
    const readFile = async (): Promise<string> => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };
    const ownership = new SessionOwnership(path.join(dir, 'sessions'), 'tui', { heartbeatMs: 20, deps: { ...defaultLeaseDeps, readFile } });
    manager.setOwnership(ownership, { tailIntervalMs: 20 });
    await manager.init();
    hosts.push({ manager, ownership, sent, store });

    await manager.setVisible([session.state.id]);
    const errored = sent.some((m) => m.t === 'session-patch' && m.id === session.state.id
      && m.patch.op === 'append' && m.patch.item.role === 'error');
    assert.deepStrictEqual([errored, manager.isForeign(session.state.id), owner.ownership.owns(session.state.id)], [true, true, true]);
  });

  test('isForeign reports roster-only and opened foreign sessions alike', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    assert.strictEqual(guest.manager.isForeign(session.state.id), true);
    assert.strictEqual(owner.manager.isForeign(session.state.id), false);
  });

  test('a session leased elsewhere that the guest never opened still carries the owner', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    assert.deepStrictEqual(guest.manager.summaries().find((x) => x.id === session.state.id)?.owner, { host: 'vscode', pid: process.pid });
  });
});

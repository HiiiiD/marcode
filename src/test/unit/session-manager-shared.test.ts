import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '../../host/session-manager';
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

  test('a session leased elsewhere that the guest never opened still carries the owner', async () => {
    const owner = await host('vscode');
    const session = await ownedSession(owner);
    const guest = await host('tui');
    await guest.manager.syncRoster();
    assert.deepStrictEqual(guest.manager.summaries().find((x) => x.id === session.state.id)?.owner, { host: 'vscode', pid: process.pid });
  });
});

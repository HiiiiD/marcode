import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, teardown, test } from 'mocha';
import { createHost } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import { resolveWorkspaceDir } from '../../host/workspace-dir';
import type { HostToWebview } from '../../protocol/messages';
import { writeCredentials } from '../../sync/credentials';
import { encodeCode } from '../../sync/pairing-code';
import { SyncClient } from '../../sync/sync-client';
import { hashSecret } from '../../sync-server/auth';
import { startSyncServer } from '../../sync-server/server';
import { SyncStore } from '../../sync-server/store';

const cleanups: Array<() => Promise<void> | void> = [];
teardown(async () => { while (cleanups.length) { await cleanups.pop()!(); } });

const tmp = async (p: string) => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
// A clone of git@github.com:a/b.git whose main is "pushed": its upstream ref points at HEAD, so the move check passes.
async function clone(): Promise<string> {
  const dir = await tmp('marcode-e2e-repo-');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:a/b.git');
  git('commit', '-q', '--allow-empty', '-m', 'i');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('branch', '--set-upstream-to=origin/main');
  return dir;
}

const until = async (done: () => Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) { if (Date.now() > deadline) { throw new Error('timed out'); } await new Promise((r) => setTimeout(r, 100)); }
};

suite('moving a session between devices (end to end)', function () {
  this.timeout(60_000);

  test('a session running on one machine moves to another, continues there, and reads as remote where it was', async () => {
    const store = new SyncStore(path.join(await tmp('marcode-e2e-srv-'), 's.sqlite'));
    const bytes = randomBytes(16);
    store.setBootstrap(hashSecret(bytes));
    const server = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
    cleanups.push(async () => { await server.close(); store.close(); });
    const enrolled = await SyncClient.enroll(server.url, encodeCode('MRB', bytes), 'desk');
    if (!enrolled.ok) { throw new Error(enrolled.error); }
    const pairing = await new SyncClient(enrolled.value).createPairing();
    if (!pairing.ok) { throw new Error(pairing.error); }
    const joined = await SyncClient.join(server.url, pairing.value.code, 'laptop');
    if (!joined.ok) { throw new Error(joined.error); }

    const boot = async (creds: typeof enrolled.value) => {
      const home = await tmp('marcode-e2e-home-');
      await writeCredentials(home, creds);
      const repo = await clone();
      const workspaceDir = await resolveWorkspaceDir(home, repo);
      const sent: HostToWebview[] = [];
      const host = await createHost({
        workspaceDir, hostKind: 'tui', workspaceRoots: () => [repo], emit: (m) => sent.push(m), notify: { warn: () => {} }, marcodeHome: home,
        config: { ...defaultHostConfig(), enabledProviders: ['fake'] }, pollMs: 100,
      });
      cleanups.push(() => host.dispose());
      await host.init();
      return { host, repo, sent };
    };
    const desk = await boot(enrolled.value);
    const laptop = await boot(joined.value);

    const session = await desk.host.manager.create('fake', desk.repo);
    const id = session.state.id;
    session.send('first message');
    await until(async () => laptop.host.manager.summaries().some((s) => s.id === id && s.remote));

    const panel = await laptop.host.manager.moveService!.panel(id);
    assert.deepStrictEqual([panel.mode, panel.defaultRoot, panel.thread], ['move', laptop.repo, 'restarted']);

    const statuses: string[] = [];
    await laptop.host.manager.moveService!.moveHere(id, { root: laptop.repo }, { cancelTurn: false }, (s) => {
      statuses.push(s.state === 'failed' ? `failed: ${s.reason}` : s.state);
    });
    assert.strictEqual(statuses.at(-1), 'done');
    const moved = laptop.host.manager.summaries().find((s) => s.id === id);
    assert.deepStrictEqual([moved?.remote, moved?.cwd], [undefined, laptop.repo]);

    // Before any new turn here: the moved transcript must already reach the device it came from.
    await until(async () => desk.host.manager.summaries().some((s) => s.id === id && s.remote?.deviceName === 'laptop'));
    await desk.host.manager.setVisible([id]);
    await until(async () => desk.sent.some((m) => m.t === 'session-snapshot' && m.session.id === id
      && m.session.items.some((i) => i.role === 'user' && i.text === 'first message')));

    const live = await laptop.host.manager.open(id);
    live.send('second message, on the laptop');
    await until(async () => live.state.status === 'idle'
      && (await laptop.host.store.tail(id, 100)).items.some((i) => i.role === 'user' && i.text === 'second message, on the laptop'));

    await until(async () => desk.host.manager.summaries().some((s) => s.id === id && s.remote?.deviceName === 'laptop'));
  });
});

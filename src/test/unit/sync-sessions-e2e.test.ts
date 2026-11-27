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
async function clone(): Promise<string> {
  const dir = await tmp('marcode-e2e-repo-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:a/b.git');
  return dir;
}

const until = async (done: () => Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!(await done())) { if (Date.now() > deadline) { throw new Error('timed out'); } await new Promise((r) => setTimeout(r, 100)); }
};

suite("other devices' sessions (end to end)", function () {
  this.timeout(60_000);

  test('a session on one machine shows on the other, follows live, and goes when deleted', async () => {
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

    const boot = async (creds: typeof enrolled.value, memoryEnabled: boolean) => {
      const home = await tmp('marcode-e2e-home-');
      await writeCredentials(home, creds);
      const repo = await clone();
      const workspaceDir = await resolveWorkspaceDir(home, repo);
      const sent: HostToWebview[] = [];
      const config = defaultHostConfig();
      const host = await createHost({
        workspaceDir, hostKind: 'tui', workspaceRoots: () => [repo], emit: (m) => sent.push(m), notify: { warn: () => {} }, marcodeHome: home,
        config: { ...config, enabledProviders: ['fake'], memory: { ...config.memory, enabled: memoryEnabled } }, pollMs: 100,
      });
      cleanups.push(() => host.dispose());
      await host.init();
      return { host, repo, sent };
    };
    const desk = await boot(enrolled.value, true);
    const laptop = await boot(joined.value, false);

    const session = await desk.host.manager.create('fake', desk.repo);
    const id = session.state.id;
    session.send('first message');

    await until(async () => laptop.host.manager.summaries().some((s) => s.id === id));
    const row = laptop.host.manager.summaries().find((s) => s.id === id);
    assert.deepStrictEqual([row?.remote?.deviceName, row?.remote?.relCwd], ['desk', '.']);

    await laptop.host.manager.setVisible([id]);
    await until(async () => laptop.sent.some((m) => m.t === 'session-snapshot' && m.session.id === id && m.session.items.length > 0));

    const before = laptop.sent.length;
    session.send('second message');
    await until(async () => laptop.sent.slice(before).some((m) => m.t === 'session-patch' && m.id === id
      && m.patch.op === 'append' && m.patch.item.role === 'user' && m.patch.item.text === 'second message'), 5000);

    await desk.host.manager.remove(id);
    await until(async () => !laptop.host.manager.summaries().some((s) => s.id === id));
  });
});

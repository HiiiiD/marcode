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

suite('memory across devices (end to end)', function () {
  this.timeout(60_000);

  test("a session closed on one machine is recalled on another machine's clone", async () => {
    const store = new SyncStore(path.join(await tmp('marcode-e2e-srv-'), 's.sqlite'));
    const bytes = randomBytes(16);
    store.setBootstrap(hashSecret(bytes));
    const server = await startSyncServer({ store, host: '127.0.0.1', port: 0 });
    cleanups.push(async () => { await server.close(); store.close(); });
    const enrolled = await SyncClient.enroll(server.url, encodeCode('MRB', bytes), 'desk');
    assert.strictEqual(enrolled.ok, true);
    if (!enrolled.ok) { return; }
    const pairing = await new SyncClient(enrolled.value).createPairing();
    assert.strictEqual(pairing.ok, true);
    if (!pairing.ok) { return; }
    const joined = await SyncClient.join(server.url, pairing.value.code, 'laptop');
    assert.strictEqual(joined.ok, true);
    if (!joined.ok) { return; }

    const boot = async (creds: typeof enrolled.value) => {
      const home = await tmp('marcode-e2e-home-');
      await writeCredentials(home, creds);
      const repo = await clone();
      const workspaceDir = await resolveWorkspaceDir(home, repo);
      const host = await createHost({
        workspaceDir, hostKind: 'tui', workspaceRoots: () => [repo], emit: () => {}, notify: { warn: () => {} }, marcodeHome: home,
        config: { ...defaultHostConfig(), enabledProviders: ['fake'] },
      });
      cleanups.push(() => host.dispose());
      await host.init();
      return { host, repo };
    };
    const desk = await boot(enrolled.value);
    const laptop = await boot(joined.value);

    const session = await desk.host.manager.create('fake', desk.repo);
    session.send('Investigate the flaky zebra login test');
    await desk.host.manager.close(session.state.id);

    // The search marcode__recall runs: priming adds a relevance floor a one-document test index never reaches.
    await until(async () => {
      const scope = await laptop.host.manager.recallScopeOf(laptop.repo);
      const hits = await laptop.host.memory?.search('flaky zebra login', { ...scope, match: 'any' }) ?? [];
      return hits.some((h) => h.sessionId === session.state.id);
    });
    assert.strictEqual((await laptop.host.memory?.getDigest(session.state.id))?.title !== undefined, true);
  });
});

import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';

suite('createHost shared account cache', () => {
  let home: string;
  setup(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-acct-')); });
  teardown(async () => { await fs.rm(home, { recursive: true, force: true }); });

  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  const make = async (slug: string): Promise<HostHandle> => {
    const workspaceDir = path.join(home, 'workspaces', slug);
    await fs.mkdir(workspaceDir, { recursive: true });
    return createHost({
      workspaceDir, accountCachePath: path.join(home, 'account.sqlite'), hostKind: 'tui', workspaceRoots: () => [workspaceDir], emit: () => {},
      notify: { warn: () => {} }, pollMs: 20,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
  };

  test('two hosts in different workspaces share plan usage', async () => {
    const a = await make('a');
    let fromA;
    try {
      await a.init();
      await a.manager.refreshUsage(home);
      fromA = a.manager.usageSnapshot().fake;
      assert.strictEqual(fromA.length > 0, true);
    } finally {
      await a.dispose();
    }

    const b = await make('b');
    try {
      await b.init();
      assert.deepStrictEqual(b.manager.usageSnapshot().fake, fromA);
    } finally {
      await b.dispose();
    }
    assert.strictEqual(await exists(path.join(home, 'account.sqlite')), true);
    assert.strictEqual(await exists(path.join(home, 'workspaces', 'a', 'usage.json')), false);
    assert.strictEqual(await exists(path.join(home, 'workspaces', 'a', 'catalog.json')), false);
  });
});

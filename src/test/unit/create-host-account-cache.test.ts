import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import type { UsageWindow } from '../../providers/types';

suite('createHost shared account cache', () => {
  let home: string;
  setup(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-acct-')); });
  teardown(async () => { await fs.rm(home, { recursive: true, force: true }); });

  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  const make = async (slug: string, withHome = true): Promise<HostHandle> => {
    const workspaceDir = path.join(home, 'workspaces', slug);
    await fs.mkdir(workspaceDir, { recursive: true });
    return createHost({
      workspaceDir, marcodeHome: withHome ? home : undefined, hostKind: 'tui', workspaceRoots: () => [workspaceDir], emit: () => {},
      notify: { warn: () => {} }, pollMs: 20,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
  };

  test('two hosts in different workspaces share plan usage', async () => {
    const a = await make('a');
    let fromA: UsageWindow[] | undefined;
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

  test('a host without a marcodeHome attaches no cache and writes no account.sqlite nearby', async () => {
    const h = await make('c', false);
    try {
      await h.init();
      await h.manager.refreshUsage(home);
    } finally {
      await h.dispose();
    }
    const ws = path.join(home, 'workspaces', 'c');
    for (const dir of [ws, path.dirname(ws), path.dirname(path.dirname(ws))]) {
      assert.strictEqual(await exists(path.join(dir, 'account.sqlite')), false);
    }
  });
});

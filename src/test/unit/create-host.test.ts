import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';

suite('createHost', () => {
  let dir: string;
  const handles: { dispose(): Promise<void> }[] = [];
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-host-')); });
  teardown(async () => {
    for (const h of handles.splice(0)) { await h.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const build = async (over: Partial<ReturnType<typeof defaultHostConfig>> = {}, warnings: string[] = []) => {
    const h = await createHost({
      workspaceDir: dir, hostKind: 'tui', workspaceRoots: () => [dir], emit: (_m: HostToWebview) => {},
      notify: { warn: (m) => warnings.push(m) },
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined }, ...over },
    });
    handles.push(h);
    return h;
  };

  test('only the enabled providers are registered', async () => {
    const h = await build();
    assert.deepStrictEqual([...h.providers.keys()], ['fake']);
    assert.deepStrictEqual([...h.enabled], ['fake']);
  });

  test('an empty provider list registers nothing and constructs no backend', async () => {
    assert.strictEqual((await build({ enabledProviders: [] })).providers.size, 0);
  });

  test('a session created through the handle survives a second host reading the same directory', async () => {
    const a = await build();
    await a.init();
    const s = await a.manager.create('fake', dir);
    await a.manager.persistNow();
    const b = await build();
    await b.init();
    assert.strictEqual(b.manager.summaries().some((x) => x.id === s.state.id), true);
  });

  test('a summarizer naming an unknown provider is a warning, not a failed start', async () => {
    const warnings: string[] = [];
    await build({ memory: { enabled: true, summarizer: { mode: 'llm', provider: 'nope', model: 'm' } } }, warnings);
    assert.strictEqual(warnings.some((w) => w.includes('memory.summarizer')), true);
  });

  test('dispose releases the leases it held', async () => {
    const h = await build();
    await h.init();
    await h.manager.create('fake', dir);
    await h.dispose();
    const locks = (await fs.readdir(path.join(dir, 'sessions')).catch(() => [] as string[])).filter((n) => n.endsWith('.lock'));
    assert.deepStrictEqual(locks, []);
  });
});

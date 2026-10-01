import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootHost, memoryForRuntime, type Booted } from '../../tui/boot';
import type { HostToWebview } from '../../protocol/messages';
import { loadConfig } from '../../host/config-file';
import { reloadSignature } from '../../host/host-config';
import { resolveWorkspaceDir } from '../../host/workspace-dir';

suite('tui boot', () => {
  let tmp: string;
  let booted: Booted | undefined;
  setup(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-boot-'))); });
  teardown(async () => { await booted?.shutdown(); booted = undefined; await fs.rm(tmp, { recursive: true, force: true }); });

  const boot = async () => {
    booted = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'),
      config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    return booted;
  };

  test('ready through the loopback hydrates with the fake provider in the catalog', async () => {
    const b = await boot();
    const got: HostToWebview[] = [];
    b.loopback.transport.onMessage((m) => got.push(m));
    b.loopback.transport.post({ t: 'ready' });
    await new Promise((r) => setTimeout(r, 100));
    const hydrate = got.find((m) => m.t === 'hydrate');
    assert.strictEqual(hydrate?.t === 'hydrate' && hydrate.catalog.some((p) => p.id === 'fake'), true);
  });

  test('the workspace directory lives under the given home and is stable', async () => {
    const b = await boot();
    assert.strictEqual(b.workspaceRoot, tmp);
    const entries = await fs.readdir(path.join(tmp, 'home', 'workspaces'));
    assert.strictEqual(entries.length, 1);
  });

  test('a host that fails to init surfaces the error', async () => {
    const home = path.join(tmp, 'home');
    const dir = await resolveWorkspaceDir(home, tmp);
    await fs.writeFile(path.join(dir, 'index.json'), '{ not json');
    await assert.rejects(
      bootHost({ cwd: tmp, home, config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } } }),
      /index\.json is not valid JSON/,
    );
  });

  test('a corrupt config.json is a warning and the defaults, not a failed boot', async () => {
    await fs.mkdir(path.join(tmp, 'home'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'home', 'config.json'), '{ not json');
    const b = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'),
      config: { enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    booted = b;
    assert.strictEqual(b.warnings.some((w) => w.includes('not valid JSON')), true);
  });

  test('fileConfig is what config.json says, not the boot overrides, so a config watch does not fire at once', async () => {
    const b = await boot();
    const fromFile = await loadConfig(b.configFile);
    assert.strictEqual(reloadSignature(b.fileConfig), reloadSignature(fromFile.config));
    assert.notStrictEqual(reloadSignature(b.fileConfig), reloadSignature({ ...fromFile.config, enabledProviders: ['fake'] }));
  });

  test('shutdown twice is harmless', async () => {
    const b = await boot();
    await b.shutdown();
    await b.shutdown();
    booted = undefined;
  });

  test('memoryForRuntime turns memory off under Bun and keeps the summarizer', () => {
    assert.deepStrictEqual(memoryForRuntime({ enabled: true, summarizer: 'x' }, true), { enabled: false, summarizer: 'x' });
  });

  test('memoryForRuntime leaves memory alone under Node or when already off', () => {
    assert.strictEqual(memoryForRuntime({ enabled: true, summarizer: undefined }, false).enabled, true);
    assert.strictEqual(memoryForRuntime({ enabled: false, summarizer: undefined }, true).enabled, false);
  });
});

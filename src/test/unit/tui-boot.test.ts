import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootHost, memoryForRuntime, type Booted } from '../../tui/boot';
import type { HostToWebview } from '../../protocol/messages';

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

  test('shutdown twice is harmless', async () => {
    const b = await boot();
    await b.shutdown();
    await b.shutdown();
    booted = undefined;
  });

  test('memoryForRuntime turns memory off with a warning under Bun', () => {
    const r = memoryForRuntime({ enabled: true, summarizer: 'x' }, true);
    assert.strictEqual(r.memory.enabled, false);
    assert.strictEqual(r.memory.summarizer, 'x');
    assert.strictEqual(typeof r.warning, 'string');
  });

  test('memoryForRuntime leaves memory alone under Node or when already off', () => {
    const on = memoryForRuntime({ enabled: true, summarizer: undefined }, false);
    assert.strictEqual(on.memory.enabled, true);
    assert.strictEqual(on.warning === undefined, true);
    const off = memoryForRuntime({ enabled: false, summarizer: undefined }, true);
    assert.strictEqual(off.warning === undefined, true);
  });

  (process.versions.bun ? test : test.skip)('bootHost forces memory off under Bun and warns', async () => {
    booted = await bootHost({
      cwd: tmp, home: path.join(tmp, 'home'),
      config: { enabledProviders: ['fake'], memory: { enabled: true, summarizer: undefined } },
    });
    assert.strictEqual(booted.warnings.some((w) => w.includes('Memory is unavailable under Bun')), true);
  });
});

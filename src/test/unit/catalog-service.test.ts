import * as assert from 'assert';
import { CatalogService, catalogKey } from '../../host/catalog-service';
import { FakeProvider } from '../../providers/fake/fake-provider';
import type { AgentProvider, Invocable } from '../../providers/types';

/** The probe is fire-and-forget; let its promise chain drain before asserting. */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function recorder() {
  const seen: { key: string; entries: Invocable[] }[] = [];
  return { seen, onEntries: (key: string, entries: Invocable[]) => { seen.push({ key, entries }); } };
}

suite('CatalogService', () => {
  test('probes once per key and caches the answer', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = [{ name: 'init' }];
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    service.ensure(key, provider, '/repo');
    await settle();
    service.ensure(key, provider, '/repo');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
    assert.deepStrictEqual(service.get(key), [{ name: 'init' }]);
    assert.strictEqual(seen.length, 1);
  });

  test('a different cwd is a different key and probes again', async () => {
    const { onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = [{ name: 'init' }];

    service.ensure(catalogKey('fake', '/a'), provider, '/a');
    service.ensure(catalogKey('fake', '/b'), provider, '/b');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/a', '/b']);
  });

  test('an empty catalog is a real answer and is cached', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = [];
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    await settle();
    service.ensure(key, provider, '/repo');
    await settle();

    assert.deepStrictEqual(service.get(key), []);
    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo']);
    assert.strictEqual(seen.length, 1);
  });

  test('a failed probe caches nothing, notifies nothing, and is retried', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const provider = new FakeProvider(() => []);
    provider.invocables = new Error('nope');
    const key = catalogKey('fake', '/repo');

    service.ensure(key, provider, '/repo');
    await settle();

    assert.strictEqual(service.get(key), undefined);
    assert.strictEqual(seen.length, 0);

    provider.invocables = [{ name: 'init' }];
    service.ensure(key, provider, '/repo');
    await settle();

    assert.deepStrictEqual(provider.listInvocablesCalls, ['/repo', '/repo']);
    assert.deepStrictEqual(service.get(key), [{ name: 'init' }]);
  });

  test('a provider without listInvocables is not an error', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const bare: AgentProvider = {
      id: 'bare',
      displayName: 'Bare',
      threadScope: 'cwd',
      listModels: () => [],
      listPermissionModes: () => [],
      start: () => { throw new Error('not used in this test'); },
    };
    const key = catalogKey('bare', '/repo');

    service.ensure(key, bare, '/repo');
    await settle();

    assert.strictEqual(service.get(key), undefined);
    assert.strictEqual(seen.length, 0);
  });

  test('set() records a live event and notifies', () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const key = catalogKey('fake', '/repo');

    service.set(key, [{ name: 'fresh' }]);

    assert.deepStrictEqual(service.get(key), [{ name: 'fresh' }]);
    assert.deepStrictEqual(seen, [{ key, entries: [{ name: 'fresh' }] }]);
  });

  test('a key survives a cwd containing the separator', () => {
    assert.notStrictEqual(catalogKey('fake', 'a'), catalogKey('fak', 'ea'));
  });

  test('a live set() while a probe is in flight wins over the probe\'s stale answer', async () => {
    const { seen, onEntries } = recorder();
    const service = new CatalogService(onEntries);
    const key = catalogKey('fake', '/repo');

    let resolveProbe: (entries: Invocable[]) => void = () => {};
    const provider: AgentProvider = {
      id: 'fake',
      displayName: 'Fake',
      threadScope: 'cwd',
      listModels: () => [],
      listPermissionModes: () => [],
      start: () => { throw new Error('not used in this test'); },
      listInvocables: () => new Promise((resolve) => { resolveProbe = resolve; }),
    };

    service.ensure(key, provider, '/repo');

    // A live `commands_changed` event lands while the probe is still
    // in flight, and caches the fresher list.
    service.set(key, [{ name: 'fresh' }]);

    // The probe now resolves with what it fetched before that live event —
    // stale by the time it lands.
    resolveProbe([{ name: 'stale' }]);
    await settle();

    assert.deepStrictEqual(service.get(key), [{ name: 'fresh' }]);
    assert.deepStrictEqual(seen, [{ key, entries: [{ name: 'fresh' }] }]);
  });
});

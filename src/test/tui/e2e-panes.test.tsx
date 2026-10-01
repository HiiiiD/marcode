import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { makeTmp, mountBooted, until } from './e2e-harness';

type Mounted = Awaited<ReturnType<typeof mountBooted>>;
const mounts: Mounted[] = [];
const tmps: string[] = [];
afterEach(async () => {
  for (const m of mounts.splice(0)) { await m.destroy(); }
  for (const t of tmps.splice(0)) { await fs.rm(t, { recursive: true, force: true }); }
});

test('a session spawned the way marcode__spawn_session does gets its own pane', async () => {
  const m = await mountBooted({ prompt: 'first task' });
  mounts.push(m);
  await m.waitFrame((f) => f.includes('first task'));
  const { manager } = m.booted.host;
  const spawned = await manager.create('fake', m.booted.launchCwd, undefined);
  await manager.setVisible([...new Set([...manager.visibleIds(), spawned.state.id])]);
  await until(() => JSON.stringify(manager.layout().root).includes(spawned.state.id));
  expect(manager.layout().root.kind).toBe('split');
  expect(manager.visibleIds().length).toBe(2);
});

test('a two-pane layout survives a restart', async () => {
  const tmp = await makeTmp();
  tmps.push(tmp);
  const opts = { home: `${tmp}/home`, cwd: tmp };
  const first = await mountBooted({ ...opts, prompt: 'one' });
  await first.waitFrame((f) => f.includes('one'));
  const { manager } = first.booted.host;
  const second = await manager.create('fake', tmp, undefined);
  await manager.setVisible([...new Set([...manager.visibleIds(), second.state.id])]);
  await until(() => manager.layout().root.kind === 'split');
  await first.destroy();
  const again = await mountBooted(opts);
  mounts.push(again);
  await until(() => again.booted.host.manager.visibleIds().length === 2);
  expect(again.booted.host.manager.layout().root.kind).toBe('split');
});

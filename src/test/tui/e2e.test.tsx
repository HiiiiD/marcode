import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import { resolveWorkspaceDir } from '../../host/workspace-dir';
import { makeTmp, mountBooted, until } from './e2e-harness';

const hasReply = (f: string) => /│\s*ok\s*(│\s*)?$/m.test(f);

type Mounted = Awaited<ReturnType<typeof mountBooted>>;
const mounts: Mounted[] = [];
let other: HostHandle | undefined;
let tmps: string[] = [];

const mountTracked = async (opts: Parameters<typeof mountBooted>[0] = {}) => {
  const m = await mountBooted(opts);
  mounts.push(m);
  return m;
};

afterEach(async () => {
  await other?.dispose();
  other = undefined;
  for (const m of mounts.splice(0)) { await m.destroy(); }
  for (const t of tmps.splice(0)) { await fs.rm(t, { recursive: true, force: true }); }
});

test('a prompt argument starts a session and the fake provider answers', async () => {
  const m = await mountTracked({ prompt: 'hello fake' });
  await m.waitFrame((f) => f.includes('hello fake') && hasReply(f));
  expect(m.frame()).toContain('hello fake');
});

test('a command that needs permission shows the prompt and y lets the turn finish', async () => {
  const m = await mountTracked({ prompt: 'please rm the build folder' });
  await m.waitFrame((f) => f.includes('[y] allow'));
  await m.press('y');
  await m.waitFrame((f) => /\ballowed\b/.test(f));
  expect(m.frame()).not.toContain('[y] allow');
  await until(() => m.booted.host.manager.summaries().every((s) => s.status !== 'running' && s.status !== 'awaiting-approval'));
});

test('n then Enter denies and the turn still finishes', async () => {
  const m = await mountTracked({ prompt: 'please rm the build folder' });
  await m.waitFrame((f) => f.includes('[y] allow'));
  await m.press('n');
  await m.waitFrame((f) => f.includes('deny reason'));
  await m.press('return');
  await m.waitFrame((f) => !f.includes('[y] allow') && !f.includes('deny reason'));
  await until(() => m.booted.host.manager.summaries().every((s) => s.status !== 'running' && s.status !== 'awaiting-approval'));
  await m.waitFrame((f) => /\bdenied\b/.test(f));
});

test('a session owned by another host is read-only here and frees up on release', async () => {
  const m = await mountTracked();
  const dir = await resolveWorkspaceDir(m.home, m.booted.workspaceRoot);
  other = await createHost({
    workspaceDir: dir, hostKind: 'vscode', workspaceRoots: () => [m.booted.workspaceRoot], emit: () => {},
    notify: { warn: () => {} }, pollMs: 20,
    config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
  });
  await other.init();
  const s = await other.manager.create('fake', m.booted.workspaceRoot);
  s.send('written elsewhere');
  await until(() => s.state.status === 'idle' && s.state.updatedAt > 0 && s.state.title !== '');
  await other.manager.persistNow();
  await m.booted.host.manager.syncRoster();
  await m.waitFrame((f) => f.includes('vscode'));
  expect(m.frame()).toContain(`vscode·${process.pid}`);

  await m.press('tab');
  await m.press('tab');
  await m.press('j');
  await m.press('return');
  await m.waitFrame((f) => f.includes('Read-only here'));
  await m.waitFrame((f) => f.includes('written elsewhere'));

  const file = path.join(dir, 'sessions', `${s.state.id}.jsonl`);
  const before = await fs.readFile(file, 'utf8');
  const rowCount = m.booted.host.manager.summaries().length;
  await m.type('zzq');
  await m.press('return');
  await m.settle(300);
  expect(m.frame()).not.toContain('Message —');
  expect(m.frame()).not.toContain('zzq');
  expect(m.frame()).toContain(`vscode·${process.pid}`);
  expect(m.booted.host.manager.summaries().length).toBe(rowCount);
  expect(m.booted.host.manager.summaries().some((x) => x.id === s.state.id)).toBe(true);
  await other.manager.persistNow();
  expect(await fs.readFile(file, 'utf8')).toBe(before);

  await other.manager.close(s.state.id);
  await until(async () => { await m.booted.host.manager.syncRoster(); return !(m.booted.host.manager.summaries().find((x) => x.id === s.state.id)?.owner); });
  await m.waitFrame((f) => !f.includes('Read-only here') && f.includes('Message —'));
  expect(m.frame()).not.toContain('Read-only here');
});

test('a restarted TUI resumes the previous session with its transcript', async () => {
  const tmp = await makeTmp();
  tmps.push(tmp);
  const home = path.join(tmp, 'home');
  const first = await mountTracked({ home, cwd: tmp, prompt: 'remember this message' });
  await first.waitFrame((f) => f.includes('remember this message') && hasReply(f));
  await first.booted.host.manager.persistNow();
  await first.destroy();

  const second = await mountTracked({ home, cwd: tmp });
  await second.waitFrame((f) => f.includes('remember this message'));
  expect(second.frame()).toContain('remember this message');
});

test('closing the focused session via the roster shows the empty state and Enter brings it back', async () => {
  const m = await mountTracked({ prompt: 'closing soon' });
  await m.waitFrame((f) => f.includes('closing soon') && hasReply(f));
  await m.press('tab');
  await m.press('tab');
  await m.press('x');
  await m.waitFrame((f) => f.includes('Ctrl+N'));
  expect(m.frame()).not.toContain('closing soon');
  expect(m.frame()).not.toContain('Message —');
  await m.press('return');
  await m.waitFrame((f) => f.includes('closing soon') && f.includes('Message —'));
});

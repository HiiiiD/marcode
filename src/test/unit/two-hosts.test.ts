import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHost, type HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import type { HostToWebview } from '../../protocol/messages';

suite('two hosts, one directory', () => {
  let dir: string;
  const handles: HostHandle[] = [];
  const sent: Record<string, HostToWebview[]> = { vscode: [], tui: [] };
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-two-'));
    sent.vscode = [];
    sent.tui = [];
  });
  teardown(async () => {
    for (const h of handles.splice(0)) { await h.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const make = async (kind: 'vscode' | 'tui') => {
    const h = await createHost({
      workspaceDir: dir, hostKind: kind, workspaceRoots: () => [dir], emit: (m) => sent[kind].push(m),
      notify: { warn: () => {} }, pollMs: 20,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
    });
    await h.init();
    handles.push(h);
    return h;
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));

  test('the guest sees the owner\'s session as foreign, tails its transcript and cannot write it', async () => {
    const a = await make('vscode');
    const b = await make('tui');
    const s = await a.manager.create('fake', dir);
    s.send('hello');
    await settle();
    await a.manager.persistNow();
    await b.manager.syncRoster();

    const opened = await b.manager.open(s.state.id);
    assert.deepStrictEqual(opened.state.owner, { host: 'vscode', pid: process.pid });
    const file = path.join(dir, 'sessions', `${s.state.id}.jsonl`);
    const before = await fs.readFile(file, 'utf8');
    opened.send('nope');
    await settle();
    await b.store.flush();
    assert.strictEqual(await fs.readFile(file, 'utf8'), before);

    await b.manager.setVisible([s.state.id]);
    s.send('second');
    await settle();
    await a.manager.persistNow();
    await settle();
    const patched = sent.tui.some((m) => m.t === 'session-patch' && m.id === s.state.id);
    assert.strictEqual(patched, true);
  });

  test('after the owner closes the session the guest can run it', async () => {
    const a = await make('vscode');
    const b = await make('tui');
    const s = await a.manager.create('fake', dir);
    s.send('hello');
    await settle();
    await a.manager.persistNow();
    await b.manager.syncRoster();
    await b.manager.open(s.state.id);
    await a.manager.close(s.state.id);
    await settle();
    const taken = await b.manager.open(s.state.id);
    assert.strictEqual(taken.state.owner, undefined);
  });
});

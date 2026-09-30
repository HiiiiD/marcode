import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultLeaseDeps, STALE_MS } from '../../host/lease';
import { SessionOwnership } from '../../host/session-ownership';

suite('SessionOwnership', () => {
  let dir: string;
  const live: SessionOwnership[] = [];
  const make = (host: 'vscode' | 'tui', opts: ConstructorParameters<typeof SessionOwnership>[2] = {}) => {
    const o = new SessionOwnership(dir, host, opts);
    live.push(o);
    return o;
  };
  setup(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-own-')); });
  teardown(async () => {
    await Promise.all(live.splice(0).map((o) => o.dispose()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('the second host is told who owns the session', async () => {
    const a = make('vscode');
    const b = make('tui');
    assert.deepStrictEqual(await a.claim('s1'), { owned: true });
    const r = await b.claim('s1');
    assert.strictEqual(r.owned, false);
    if (!r.owned) { assert.deepStrictEqual(r.owner, { host: 'vscode', pid: process.pid }); }
  });

  test('ownerOf reports a live foreign owner and nothing for our own or a free session', async () => {
    const a = make('vscode');
    const b = make('tui');
    await a.claim('s1');
    assert.deepStrictEqual(await b.ownerOf('s1'), { host: 'vscode', pid: process.pid });
    assert.strictEqual(await a.ownerOf('s1'), undefined);
    assert.strictEqual(await b.ownerOf('nobody'), undefined);
  });

  test('a lease file that cannot be read for a while does not fire onLost', async () => {
    let failing = false;
    const readFile = async (file: string): Promise<string> => {
      if (failing) { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); }
      return fs.readFile(file, 'utf8');
    };
    const a = make('vscode', { heartbeatMs: 10, deps: { ...defaultLeaseDeps, readFile } });
    const lost: string[] = [];
    a.onLost((id) => lost.push(id));
    await a.claim('s1');
    failing = true;
    await new Promise((r) => setTimeout(r, 60));
    failing = false;
    assert.deepStrictEqual(lost, []);
    assert.strictEqual(a.owns('s1'), true);
  });

  test('release frees the session for the other host', async () => {
    const a = make('vscode');
    const b = make('tui');
    await a.claim('s1');
    await a.release('s1');
    assert.deepStrictEqual(await b.claim('s1'), { owned: true });
  });

  test('a host that stopped beating loses the session to a claimant after the stale window', async () => {
    let now = 0;
    const clock = { now: () => now, pidAlive: () => true, machine: 'm' };
    const a = make('vscode', { deps: clock, heartbeatMs: 1_000_000 });
    const b = make('tui', { deps: clock, heartbeatMs: 1_000_000 });
    await a.claim('s1');
    now = STALE_MS + 1;
    assert.deepStrictEqual(await b.claim('s1'), { owned: true });
  });

  test('a lease taken from us is reported through onLost', async () => {
    const lost: string[] = [];
    const a = make('vscode', { heartbeatMs: 10 });
    a.onLost((id) => lost.push(id));
    await a.claim('s1');
    await fs.rm(path.join(dir, 's1.lock'));
    await make('tui').claim('s1');
    for (let i = 0; i < 40 && lost.length === 0; i++) { await new Promise((r) => setTimeout(r, 10)); }
    assert.deepStrictEqual(lost, ['s1']);
    assert.strictEqual(a.owns('s1'), false);
  });

  test('dispose releases every held lease', async () => {
    const a = make('vscode');
    await a.claim('s1');
    await a.claim('s2');
    await a.dispose();
    assert.deepStrictEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.lock')), []);
  });
});

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDaemon, type RunningDaemon } from '../../daemon/run-daemon';
import type { HostHandle } from '../../host/create-host';
import { defaultHostConfig } from '../../host/host-config';
import { rawClient, rawHello, until, type RawClient } from '../fixtures/daemon-raw-client';

const msgs = (c: RawClient, t: string) => c.frames.filter((f) => f.f === 'msg' && f.m.t === t).map((f) => f.m);
const settle = () => new Promise((r) => setTimeout(r, 150));

suite('daemon visible set is per connection', function () {
  this.timeout(15000);
  let dir: string;
  let daemon: RunningDaemon | undefined;
  let host: HostHandle | undefined;
  const clients: RawClient[] = [];

  const attach = async () => {
    const c = await rawClient(daemon!.info.endpoint);
    clients.push(c);
    c.send(rawHello(daemon!.info));
    await until(() => c.frames.some((f) => f.f === 'welcome'));
    return c;
  };
  const createShown = async (c: RawClient) => {
    c.send({ f: 'msg', m: { t: 'create-session', providerId: 'fake', cwd: dir } });
    await until(() => msgs(c, 'session-snapshot').length > 0);
    const id: string = msgs(c, 'session-snapshot')[0].session.id;
    c.send({ f: 'msg', m: { t: 'set-visible', sessionIds: [id] } });
    await until(() => host!.manager.visibleIds().includes(id));
    return id;
  };
  const roster = () => host!.manager.summaries().map((s) => s.id);

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mar-vis-'));
    daemon = await runDaemon({
      workspaceDir: dir,
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: false, summarizer: undefined } },
      appVersion: '9.9.9', initialRoots: [dir], onHost: (h) => { host = h; },
    });
  });
  teardown(async () => {
    for (const c of clients.splice(0)) { c.sock.destroy(); }
    await daemon?.stop();
    daemon = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a second client\'s empty set-visible neither hides nor discards the first client\'s pane', async () => {
    const a = await attach();
    const id = await createShown(a);
    const b = await attach();
    b.send({ f: 'msg', m: { t: 'set-visible', sessionIds: [] } });
    await settle();
    assert.strictEqual(roster().includes(id), true);
    assert.strictEqual(host!.manager.visibleIds().includes(id), true);
    a.send({ f: 'msg', m: { t: 'send', id, text: 'hello' } });
    await until(() => msgs(a, 'session-patch').some((m) => m.id === id));
    assert.strictEqual(msgs(a, 'session-patch').some((m) => m.id === id), true);
  });

  test('a client showing a session another client already shows gets its snapshot; hiding it keeps it visible', async () => {
    const a = await attach();
    const id = await createShown(a);
    const b = await attach();
    b.send({ f: 'msg', m: { t: 'set-visible', sessionIds: [id] } });
    await until(() => msgs(b, 'session-snapshot').some((m) => m.session.id === id));
    assert.strictEqual(msgs(b, 'session-snapshot').some((m) => m.session.id === id), true);
    b.send({ f: 'msg', m: { t: 'set-visible', sessionIds: [] } });
    await settle();
    assert.strictEqual(host!.manager.visibleIds().includes(id), true);
    assert.strictEqual(roster().includes(id), true);
  });

  test('a client leaving while another remains recomputes the union', async () => {
    const a = await attach();
    const mine = await createShown(a);
    const b = await attach();
    b.send({ f: 'msg', m: { t: 'create-session', providerId: 'fake', cwd: dir } });
    await until(() => msgs(b, 'session-snapshot').length > 0);
    const theirs: string = msgs(b, 'session-snapshot')[0].session.id;
    b.send({ f: 'msg', m: { t: 'set-visible', sessionIds: [theirs] } });
    await until(() => host!.manager.visibleIds().length === 2);
    assert.deepStrictEqual(host!.manager.visibleIds().sort(), [mine, theirs].sort());
    a.sock.destroy();
    await until(() => !host!.manager.visibleIds().includes(mine));
    assert.deepStrictEqual(host!.manager.visibleIds(), [theirs]);
  });

  test('the last client leaving keeps the last union: nothing is hidden or discarded', async () => {
    const a = await attach();
    const id = await createShown(a);
    a.sock.destroy();
    await until(() => a.closed());
    await settle();
    assert.deepStrictEqual(host!.manager.visibleIds(), [id]);
    assert.strictEqual(roster().includes(id), true);
  });
});

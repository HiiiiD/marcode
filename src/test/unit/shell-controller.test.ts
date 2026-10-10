import * as assert from 'assert';
import { ShellController, type ShellHost } from '../../host/shell/shell-controller';
import { DEFAULT_SHELL_ALIASES } from '../../host/shell/shell-aliases';
import type { ShellResult, ShellRunOptions } from '../../host/shell/shell-runner';
import type { ShellItem } from '../../protocol/messages';

function harness() {
  const log: string[] = [];
  const items = new Map<string, ShellItem>();
  let n = 0;
  const host: ShellHost = {
    cwd: () => '/repo', aliases: () => DEFAULT_SHELL_ALIASES, nextId: () => `sh${++n}`,
    append: (i) => { items.set(i.id, i); log.push(`append:${i.id}`); },
    replace: (i) => { items.set(i.id, i); log.push(`replace:${i.id}:${i.state}`); },
    refuse: (m) => { log.push(`refuse:${m}`); },
  };
  const runs: { opts: ShellRunOptions; push: (o: string) => void; finish: (r: ShellResult) => void; cancelled: boolean }[] = [];
  const run = ((opts: ShellRunOptions, onUpdate: (o: string, t: boolean) => void) => {
    let resolve!: (r: ShellResult) => void;
    const done = new Promise<ShellResult>((r) => { resolve = r; });
    const rec = { opts, cancelled: false, push: (o: string) => onUpdate(o, false), finish: resolve };
    runs.push(rec);
    return { cancel: () => { rec.cancelled = true; resolve({ cancelled: true }); }, done };
  }) as never;
  return { c: new ShellController(host, run), log, items, runs };
}
const settle = () => new Promise((r) => setImmediate(r));

suite('ShellController', () => {
  test('start appends a running item, streams updates, finalizes on exit', async () => {
    const { c, items, runs } = harness();
    c.start('ls');
    assert.strictEqual(items.get('sh1')!.state, 'running');
    assert.strictEqual(runs[0].opts.cwd, '/repo');
    runs[0].push('a\n');
    assert.strictEqual(items.get('sh1')!.output, 'a\n');
    runs[0].finish({ exitCode: 0 });
    await settle();
    assert.deepStrictEqual([items.get('sh1')!.state, items.get('sh1')!.exitCode], ['done', 0]);
    assert.strictEqual(c.isRunning('sh1'), false);
  });
  test('a second command while one runs is refused', () => {
    const { c, log, runs } = harness();
    c.start('sleep 1');
    c.start('ls');
    assert.strictEqual(runs.length, 1);
    assert.strictEqual(log.some((l) => l.startsWith('refuse:')), true);
  });
  test('cancel ends the item cancelled', async () => {
    const { c, items } = harness();
    c.start('sleep 1');
    c.cancel('sh1');
    await settle();
    assert.strictEqual(items.get('sh1')!.state, 'cancelled');
  });
  test('an error result is kept on the item', async () => {
    const { c, items, runs } = harness();
    c.start('x');
    runs[0].finish({ error: 'boom' });
    await settle();
    assert.deepStrictEqual([items.get('sh1')!.state, items.get('sh1')!.error], ['done', 'boom']);
  });
  test('dispose marks a running item cancelled/interrupted and kills it', () => {
    const { c, items, runs } = harness();
    c.start('sleep 9');
    c.dispose();
    assert.strictEqual(runs[0].cancelled, true);
    assert.deepStrictEqual([items.get('sh1')!.state, items.get('sh1')!.error], ['cancelled', 'interrupted']);
  });
});

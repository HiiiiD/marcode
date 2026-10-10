import * as assert from 'node:assert';
import { hooksToClient } from '../../host/act-adapter';

suite('act adapter', () => {
  const calls: string[] = [];
  const noop = () => {};
  const set = {
    editor: {
      current: () => null, reveal: (p: string, l?: number) => { calls.push(`reveal:${p}:${l}`); },
      openDiff: noop, openSettings: noop, openExternal: noop, exportCsv: noop, exportImage: noop, login: noop,
    },
    picker: { pick: async () => ['/p'] },
    fileSearch: { search: async (q: string) => [{ path: q }] as never },
    configHost: { setFavoriteModels: (ids: string[]) => { calls.push(`fav:${ids.join(',')}`); } },
  };
  const notice = {
    info: (t: string) => calls.push(`i:${t}`), warn: (t: string) => calls.push(`w:${t}`),
    shellNoise: (p: string) => calls.push(`s:${p}`),
  };
  const c = hooksToClient(set, notice);

  test('routes acts to the matching host call', () => {
    c.act!('reveal', ['/a.ts', 3]);
    c.act!('setFavoriteModels', [['m']]);
    c.act!('notify', ['warn', 'boom']);
    c.act!('notify', ['info', 'fyi']);
    c.act!('shellNoise', ['P']);
    assert.deepStrictEqual(calls, ['reveal:/a.ts:3', 'fav:m', 'w:boom', 'i:fyi', 's:P']);
  });

  test('ask answers pick and search', async () => {
    assert.deepStrictEqual(await c.ask!('pick', []), ['/p']);
    assert.deepStrictEqual(await c.ask!('search', ['q']), [{ path: 'q' }]);
  });
});

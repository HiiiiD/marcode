import * as assert from 'assert';
import { recentCombos } from '../../client-core/create-recents';
import type { ProviderInfo, SessionSummary } from '../../protocol/messages';
import { summary } from '../fixtures/protocol';

const catalog: ProviderInfo[] = [{
  id: 'fake', displayName: 'Fake', permissionModes: [],
  models: [{ id: 'm1', displayName: 'M1', effort: { levels: ['low', 'high'], default: 'high' } }, { id: 'm2', displayName: 'M2' }],
}];

const made = (id: string, createdAt: number, over: Partial<SessionSummary>): SessionSummary =>
  ({ ...summary(id), providerId: 'fake', createdAt, ...over });

suite('recentCombos', () => {
  test('lists distinct model/effort/mode triples, newest first', () => {
    const sessions = [
      made('a', 1, { model: 'm1', effort: 'low', permissionMode: 'default' }),
      made('b', 3, { model: 'm1', effort: 'high', permissionMode: 'plan' }),
      made('c', 2, { model: 'm1', effort: 'low', permissionMode: 'default' }),
    ];
    assert.deepStrictEqual(recentCombos(sessions, catalog).map((c) => [c.model, c.effort, c.mode]), [
      ['m1', 'high', 'plan'],
      ['m1', 'low', 'default'],
    ]);
  });

  test('skips a model that has left the catalog and drops an effort the model does not offer', () => {
    const sessions = [
      made('a', 2, { model: 'gone', permissionMode: 'default' }),
      made('b', 1, { model: 'm2', effort: 'high', permissionMode: 'default' }),
    ];
    assert.deepStrictEqual(recentCombos(sessions, catalog), [{ providerId: 'fake', model: 'm2', mode: 'default' }]);
  });

  test('never offers more than the limit, and ignores subagents and side chats', () => {
    const sessions = [
      ...[1, 2, 3, 4, 5].map((n) => made(`s${n}`, n, { model: 'm1', effort: n % 2 ? 'low' : 'high', permissionMode: n > 3 ? 'plan' : 'default' })),
      made('x', 9, { model: 'm2', kind: 'subagent' }),
    ];
    const out = recentCombos(sessions, catalog, 3);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out.every((c) => c.model === 'm1'), true);
  });
});

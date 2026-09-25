import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { DEFAULT_QUERY, queryHistory } from '../../history/history-rows';
import { summary } from '../fixtures/protocol';

const ids = (list: { id: string }[]): string[] => list.map((s) => s.id);

const sessions = [
  summary('a', { createdAt: 10, updatedAt: 300 }),
  summary('b', { createdAt: 30, updatedAt: 100 }),
  summary('c', { createdAt: 20, updatedAt: 200 }),
];

suite('queryHistory', () => {
  test('default sorts by last updated, newest first', () => {
    assert.deepStrictEqual(ids(queryHistory(sessions, DEFAULT_QUERY).rest), ['a', 'c', 'b']);
  });

  test('ascending reverses', () => {
    const q = { ...DEFAULT_QUERY, dir: 'asc' as const };
    assert.deepStrictEqual(ids(queryHistory(sessions, q).rest), ['b', 'c', 'a']);
  });

  test('sorts by created', () => {
    const q = { ...DEFAULT_QUERY, sort: 'createdAt' as const };
    assert.deepStrictEqual(ids(queryHistory(sessions, q).rest), ['b', 'c', 'a']);
  });

  test('pinned sessions group first and sort within themselves', () => {
    const list = [
      summary('a', { updatedAt: 300 }),
      summary('p1', { updatedAt: 10, pinned: true }),
      summary('p2', { updatedAt: 20, pinned: true }),
    ];
    const out = queryHistory(list, DEFAULT_QUERY);
    assert.deepStrictEqual(ids(out.pinned), ['p2', 'p1']);
    assert.deepStrictEqual(ids(out.rest), ['a']);
  });

  test('text matches title, name, model, provider and summary, case-insensitively', () => {
    const list = [
      summary('t', { title: 'Login Bug' }),
      summary('n', { name: 'refactor-x' }),
      summary('m', { model: 'Opus-Special' }),
      summary('s', { summary: { text: 'Migrated the DB', forUpdatedAt: 0 } }),
      summary('none'),
    ];
    const find = (text: string): string[] => ids(queryHistory(list, { ...DEFAULT_QUERY, text }).rest);
    assert.deepStrictEqual(find('login'), ['t']);
    assert.deepStrictEqual(find('REFACTOR'), ['n']);
    assert.deepStrictEqual(find('opus'), ['m']);
    assert.deepStrictEqual(find('migrated'), ['s']);
  });

  test('ties break by id and the input is not mutated', () => {
    const list = [summary('z', { updatedAt: 5 }), summary('y', { updatedAt: 5 })];
    const before = ids(list);
    assert.deepStrictEqual(ids(queryHistory(list, DEFAULT_QUERY).rest), ['y', 'z']);
    assert.deepStrictEqual(ids(list), before);
  });
});

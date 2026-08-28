import * as assert from 'assert';
import type { ModelInfo } from '../../providers/types';
import { findModel, isFavorite, modelKey, resolveEffort, sortFavoritesFirst } from '../../shared/model-catalog';

const MODELS: ModelInfo[] = [
  { id: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5' },
  { id: 'opus', displayName: 'Opus (1M context)', resolvedModel: 'claude-opus-5[1m]' },
  { id: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5' },
  { id: 'claude-sonnet-5', displayName: 'Sonnet' },
];

suite('findModel', () => {
  test('matches a row by its own id', () => {
    assert.strictEqual(findModel(MODELS, 'fable')?.displayName, 'Fable');
    assert.strictEqual(findModel(MODELS, 'claude-sonnet-5')?.displayName, 'Sonnet');
  });

  test('matches a persisted wire id against the alias row covering it', () => {
    assert.strictEqual(findModel(MODELS, 'claude-fable-5')?.id, 'fable');
  });

  test('an exact id wins over an alias that resolves to it', () => {
    const models: ModelInfo[] = [
      { id: 'opus', displayName: 'Alias', resolvedModel: 'claude-opus-5' },
      { id: 'claude-opus-5', displayName: 'Exact' },
    ];
    assert.strictEqual(findModel(models, 'claude-opus-5')?.displayName, 'Exact');
  });

  test('the first alias wins when several resolve to the same wire id', () => {
    // Not arbitrary: the CLI lists its recommended row first, so a session
    // pinned to a bare wire id lands on the row the CLI would have picked.
    assert.strictEqual(findModel(MODELS, 'claude-opus-5')?.id, 'default');
  });

  test('an unknown id and an absent id both find nothing', () => {
    assert.strictEqual(findModel(MODELS, 'gpt-9'), undefined);
    assert.strictEqual(findModel(MODELS, undefined), undefined);
    assert.strictEqual(findModel([], 'fable'), undefined);
  });
});

const WITH_EFFORT: ModelInfo = {
  id: 'opus', displayName: 'Opus',
  effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
};
const WITHOUT_EFFORT: ModelInfo = { id: 'haiku', displayName: 'Haiku' };

suite('resolveEffort', () => {
  test('keeps a level the model supports', () => {
    assert.strictEqual(resolveEffort(WITH_EFFORT, 'low'), 'low');
  });

  test('falls back to the model default for a level it does not offer', () => {
    assert.strictEqual(resolveEffort(WITH_EFFORT, 'max'), 'medium');
  });

  test('falls back to the model default when nothing is requested', () => {
    assert.strictEqual(resolveEffort(WITH_EFFORT, undefined), 'medium');
  });

  test('a model with no effort control resolves to no effort at all', () => {
    assert.strictEqual(resolveEffort(WITHOUT_EFFORT, 'high'), undefined);
    assert.strictEqual(resolveEffort(WITHOUT_EFFORT, undefined), undefined);
  });

  test('an unknown row leaves the requested level untouched', () => {
    // No row means no opinion — a catalog that has not loaded yet, or a
    // provider that reports none, must not silently wipe a real choice.
    assert.strictEqual(resolveEffort(undefined, 'high'), 'high');
    assert.strictEqual(resolveEffort(undefined, undefined), undefined);
  });
});

suite('modelKey', () => {
  test('joins provider and model id with a space', () => {
    assert.strictEqual(modelKey('opencode', 'gpt-4'), 'opencode gpt-4');
  });
});

suite('isFavorite', () => {
  test('true when the key is in the favorites list', () => {
    assert.strictEqual(isFavorite('opencode', 'fable', ['opencode fable']), true);
  });

  test('false for an unstarred model, or a same-id row under a different provider', () => {
    assert.strictEqual(isFavorite('opencode', 'fable', []), false);
    assert.strictEqual(isFavorite('opencode', 'fable', ['claude fable']), false);
  });
});

suite('sortFavoritesFirst', () => {
  test('moves starred rows to the front, each group keeping its relative order', () => {
    const sorted = sortFavoritesFirst(MODELS, 'opencode', ['opencode fable', 'opencode opus']);
    assert.deepStrictEqual(sorted.map((m) => m.id), ['opus', 'fable', 'default', 'claude-sonnet-5']);
  });

  test('is a no-op when nothing is starred', () => {
    assert.deepStrictEqual(sortFavoritesFirst(MODELS, 'opencode', []), MODELS);
  });

  test('does not treat another provider\'s star as this provider\'s', () => {
    assert.deepStrictEqual(sortFavoritesFirst(MODELS, 'opencode', ['claude fable']), MODELS);
  });
});

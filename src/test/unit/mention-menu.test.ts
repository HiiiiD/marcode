import * as assert from 'assert';
import {
  filterMentions, pruneMentions, mentionQuery, spliceMention, tokenFor,
  type MentionOption, type PendingMention,
} from '../../webview/lib/mention-menu';

function option(baseToken: string, label: string, group = 'Sessions'): MentionOption<{ tag: string }> {
  return {
    id: baseToken, label, hint: '', group, baseToken,
    payload: { tag: 'test' },
  };
}

suite('mention menu', () => {
  test('opens on @ at the start of the text', () => {
    assert.deepStrictEqual(mentionQuery('@', 1), { query: '', start: 0 });
  });

  test('opens on @ after a space, mid-prose', () => {
    assert.deepStrictEqual(mentionQuery('use @pla', 8), { query: 'pla', start: 4 });
  });

  test('does not open on an @ glued to a word', () => {
    assert.strictEqual(mentionQuery('me@example.com', 14), undefined);
  });

  test('closes once the query contains whitespace', () => {
    assert.strictEqual(mentionQuery('@plan now', 9), undefined);
  });

  test('ignores an @ that is after the caret', () => {
    assert.strictEqual(mentionQuery('hello @x', 5), undefined);
  });

  test('filters on label and base token, across any source', () => {
    const options = [
      option('refactor-store:plan', 'refactor store'),
      option('refactor-store:message', 'refactor store'),
      option('handoff', 'handoff', 'Actions'),
    ];
    assert.strictEqual(filterMentions(options, 'refac').length, 2);
    assert.strictEqual(filterMentions(options, 'hand').length, 1);
    // The base token is matchable, so a source that puts a path there is
    // searchable by path with no change here.
    assert.strictEqual(filterMentions(options, ':plan').length, 1);
    assert.strictEqual(filterMentions(options, '').length, 3);
  });

  test('group headings come from the source', () => {
    const action = option('handoff', 'handoff', 'Actions');
    assert.strictEqual(action.group, 'Actions');
    const session = option('refactor-store:plan', 'refactor store', 'Sessions');
    assert.strictEqual(session.group, 'Sessions');
  });

  test('tokenFor prefixes the base token and disambiguates a collision', () => {
    const o = option('refactor-store:plan', 'refactor store');
    assert.strictEqual(tokenFor(o, []), '@refactor-store:plan');
    assert.strictEqual(tokenFor(o, ['@refactor-store:plan']), '@refactor-store:plan-2');
    assert.strictEqual(
      tokenFor(o, ['@refactor-store:plan', '@refactor-store:plan-2']),
      '@refactor-store:plan-3',
    );
  });

  test('spliceMention replaces the query span and leaves the caret after it', () => {
    const out = spliceMention('use @pla and go', 4, 8, '@refactor-store:plan');
    assert.strictEqual(out.text, 'use @refactor-store:plan and go');
    assert.strictEqual(out.caret, 24);
  });

  test('pruneMentions drops a mention whose token the user deleted', () => {
    const pending: PendingMention<{ id: string }>[] = [
      { token: '@a', payload: { id: 'a' } },
      { token: '@b', payload: { id: 'b' } },
    ];
    assert.strictEqual(pruneMentions('only @a survives', pending).length, 1);
    assert.strictEqual(pruneMentions('neither', pending).length, 0);
  });

  /**
   * `tokenFor` disambiguates a collision by appending `-2`, and `@a:plan` is a
   * plain substring of `@a:plan-2` — so a `includes` test keeps the deleted
   * first token alive and sends a payload the user removed.
   */
  test('pruneMentions drops the first of two colliding tokens', () => {
    const pending: PendingMention<{ id: string }>[] = [
      { token: '@a:plan', payload: { id: 'first' } },
      { token: '@a:plan-2', payload: { id: 'second' } },
    ];

    const left = pruneMentions('kept @a:plan-2 only', pending);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].payload.id, 'second');

    // The other way round, and both together, for symmetry.
    assert.strictEqual(pruneMentions('kept @a:plan only', pending).length, 1);
    assert.strictEqual(pruneMentions('@a:plan and @a:plan-2', pending).length, 2);
  });

  test('pruneMentions keeps a token followed by ordinary prose', () => {
    const pending: PendingMention<{ id: string }>[] = [
      { token: '@a:plan', payload: { id: 'a' } },
    ];
    assert.strictEqual(pruneMentions('see @a:plan, then go', pending).length, 1);
    assert.strictEqual(pruneMentions('see @a:plan then go', pending).length, 1);
  });

  /**
   * A token that is a strict prefix of a LONGER token, with no collision
   * suffix in sight: two sessions titled `refactor store` and `refactor store
   * two` slug to exactly this pair. Deleting the short one leaves the long one
   * standing, and a prefix match would keep the deleted reference attached and
   * send a payload the user removed.
   */
  test('pruneMentions drops a token that survives only as another token prefix', () => {
    const pending: PendingMention<{ id: string }>[] = [
      { token: '@refactor-store', payload: { id: 'short' } },
      { token: '@refactor-store-two', payload: { id: 'long' } },
    ];

    const left = pruneMentions('kept @refactor-store-two only', pending);
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].payload.id, 'long');
  });
});

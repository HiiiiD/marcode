import * as assert from 'assert';
import { interceptFor } from '../../webview/lib/intercepts';

suite('interceptFor', () => {
  test('claims /context for the panel', () => {
    assert.strictEqual(interceptFor('/context'), 'context');
  });

  test('ignores surrounding whitespace the composer would trim anyway', () => {
    assert.strictEqual(interceptFor('  /context  '), 'context');
  });

  test('leaves an ordinary message alone', () => {
    assert.strictEqual(interceptFor('what is in the context?'), undefined);
  });

  test('leaves a command the panel has no surface for alone', () => {
    assert.strictEqual(interceptFor('/cost'), undefined);
  });

  /**
   * Arguments mean the user wants the agent's own command, not the panel's
   * rendering of it — there is nothing here that could act on them.
   */
  test('does not claim a command that carries arguments', () => {
    assert.strictEqual(interceptFor('/context --verbose'), undefined);
  });

  /**
   * `/contextual-help` starts with the intercepted command's characters and
   * is a different command entirely.
   */
  test('does not claim a longer command that merely starts the same way', () => {
    assert.strictEqual(interceptFor('/contextual-help'), undefined);
  });
});

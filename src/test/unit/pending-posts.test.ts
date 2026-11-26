import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { PendingPosts } from '../../host/pending-posts';

suite('PendingPosts', () => {
  test('holds messages until a target exists, then delivers them in order', () => {
    const delivered: number[] = [];
    const posts = new PendingPosts<number>();
    posts.post(1);
    posts.post(2);
    assert.strictEqual(delivered.length, 0);
    posts.attach((n) => { delivered.push(n); });
    posts.post(3);
    assert.deepStrictEqual(delivered, [1, 2, 3]);
  });

  test('a detached target queues again', () => {
    const delivered: number[] = [];
    const posts = new PendingPosts<number>();
    posts.attach((n) => { delivered.push(n); });
    posts.detach();
    posts.post(1);
    assert.strictEqual(delivered.length, 0);
    posts.attach((n) => { delivered.push(n); });
    assert.deepStrictEqual(delivered, [1]);
  });
});

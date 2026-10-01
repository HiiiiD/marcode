import * as assert from 'node:assert';

suite('check-tui-asserts', () => {
  test('flags a renderer in an assertion and passes a frame string', async () => {
    // @ts-expect-error untyped script
    const { findViolations } = await import('../../../scripts/check-tui-asserts.mjs');
    assert.strictEqual(findViolations('expect(setup.renderer).toBeDefined()').length, 1);
    assert.strictEqual(findViolations('expect(setup.captureCharFrame()).toContain("ok")').length, 0);
  });
});

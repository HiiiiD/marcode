import * as assert from 'node:assert';
import { hitsContext, PICKER_HINT, statusLayout } from '../../tui/view/status-line';

const base = { provider: 'Fake', model: 'fake-large', effort: 'high', permissionMode: 'plan', owned: true };
const HEAD = 'Fake · fake-large · high · plan';

suite('tui status layout', () => {
  test('without a context percent there is no ctx segment', () => {
    const l = statusLayout({ ...base, width: 200 });
    assert.strictEqual(l.ctx, undefined);
    assert.strictEqual(l.text.includes('ctx'), false);
  });
  test('ctx follows the head and the hint follows ctx', () => {
    const l = statusLayout({ ...base, contextPercent: 42, width: 200 });
    assert.strictEqual(l.text, `${HEAD} · ctx 42%   ${PICKER_HINT}`);
    assert.deepStrictEqual(l.ctx, { start: HEAD.length + 3, end: HEAD.length + 3 + 'ctx 42%'.length, danger: false });
  });
  test('80 and above is danger', () => {
    assert.strictEqual(statusLayout({ ...base, contextPercent: 80, width: 200 }).ctx?.danger, true);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 79, width: 200 }).ctx?.danger, false);
  });
  test('the hint goes first, then ctx, then the head is ellipsized', () => {
    const noHint = `${HEAD} · ctx 42%`;
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: noHint.length }).text, noHint);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: HEAD.length }).text, HEAD);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: HEAD.length }).ctx, undefined);
    assert.strictEqual(statusLayout({ ...base, contextPercent: 42, width: 12 }).text, 'Fake · fake…');
  });
  test('a foreign session gets no hint but keeps ctx', () => {
    const l = statusLayout({ ...base, contextPercent: 42, owned: false, width: 200 });
    assert.strictEqual(l.text, `${HEAD} · ctx 42%`);
  });
  test('out-of-range percents are clamped', () => {
    assert.strictEqual(statusLayout({ ...base, contextPercent: 250, width: 200 }).text.includes('ctx 100%'), true);
    assert.strictEqual(statusLayout({ ...base, contextPercent: -4, width: 200 }).text.includes('ctx 0%'), true);
  });
  test('hitsContext is true only inside the ctx segment', () => {
    const l = statusLayout({ ...base, contextPercent: 42, width: 200 });
    const s = l.ctx!.start;
    assert.strictEqual(hitsContext(l, s - 1), false);
    assert.strictEqual(hitsContext(l, s), true);
    assert.strictEqual(hitsContext(l, l.ctx!.end - 1), true);
    assert.strictEqual(hitsContext(l, l.ctx!.end), false);
    assert.strictEqual(hitsContext(statusLayout({ ...base, width: 200 }), 0), false);
  });
});

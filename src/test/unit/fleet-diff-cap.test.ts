import * as assert from 'node:assert';
import { clampCap, FILE_CAP, MAX_FILE_CAP } from '../../host/fleet-diff';

suite('clampCap', () => {
  test('an absent cap is the default', () => {
    assert.strictEqual(clampCap(undefined), FILE_CAP);
  });

  test('a raised cap is honoured up to the ceiling', () => {
    assert.strictEqual(clampCap(1200), 1200);
    assert.strictEqual(clampCap(MAX_FILE_CAP), MAX_FILE_CAP);
  });

  test('the ceiling is hard — an unbounded list cannot be requested', () => {
    assert.strictEqual(clampCap(50_000), MAX_FILE_CAP);
    assert.strictEqual(clampCap(Number.POSITIVE_INFINITY), MAX_FILE_CAP);
  });

  test('nonsense falls back to the default rather than to zero rows', () => {
    assert.strictEqual(clampCap(0), FILE_CAP);
    assert.strictEqual(clampCap(-5), FILE_CAP);
    assert.strictEqual(clampCap(Number.NaN), FILE_CAP);
  });
});

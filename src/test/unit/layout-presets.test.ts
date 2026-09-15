import * as assert from 'assert';
import { BUILTIN_PRESETS, shapeMatches } from '../../webview/components/layout-presets';

suite('layout-presets BUILTIN_PRESETS', () => {
  test('every built-in preset is shape-only (no sessionId anywhere)', () => {
    for (const preset of BUILTIN_PRESETS) {
      const hasSession = JSON.stringify(preset.root).includes('"sessionId":"');
      assert.strictEqual(hasSession, false, `${preset.name} has a non-null sessionId`);
    }
  });

  test('2x2 grid has 4 slots', () => {
    const grid = BUILTIN_PRESETS.find((p) => p.id === 'grid-2x2')!;
    assert.strictEqual(grid.root.kind, 'split');
  });
});

suite('layout-presets shapeMatches', () => {
  test('a filled tree matches the shape it was filled from', () => {
    const shape = BUILTIN_PRESETS.find((p) => p.id === 'stack-2')!.root;
    const filled = {
      kind: 'split' as const, orientation: 'vertical' as const, size: 100,
      children: [
        { kind: 'leaf' as const, sessionId: 'a', size: 50 },
        { kind: 'leaf' as const, sessionId: 'b', size: 50 },
      ],
    };
    assert.strictEqual(shapeMatches(filled, shape), true);
  });

  test('a differently-shaped tree does not match', () => {
    const shape = BUILTIN_PRESETS.find((p) => p.id === 'stack-2')!.root;
    const other = { kind: 'leaf' as const, sessionId: 'a', size: 100 };
    assert.strictEqual(shapeMatches(other, shape), false);
  });
});

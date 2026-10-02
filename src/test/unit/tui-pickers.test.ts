import * as assert from 'node:assert';
import { effortRow, modeOptions, modelOptions, parsePickerCommand, windowAround } from '../../tui/view/pickers';
import { catalog, summary } from '../fixtures/protocol';

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

suite('tui pickers: model options', () => {
  test('lists every model of the session provider and marks the current one', () => {
    const rows = modelOptions(catalog(), summary('s1'), []);
    assert.deepStrictEqual(ids(rows), ['fake-large', 'fake-small', 'fake-medium']);
    assert.deepStrictEqual(rows.map((r) => r.current), [true, false, false]);
  });
  test('favorites sort first and are flagged', () => {
    const rows = modelOptions(catalog(), summary('s1'), ['fake fake-medium']);
    assert.deepStrictEqual(ids(rows), ['fake-medium', 'fake-large', 'fake-small']);
    assert.strictEqual(rows[0]?.favorite, true);
  });
  test('a current model missing from the catalog is still offered, first', () => {
    const rows = modelOptions(catalog(), summary('s1', { model: 'gone-model' }), []);
    assert.strictEqual(rows[0]?.id, 'gone-model');
    assert.strictEqual(rows[0]?.current, true);
  });
  test('the filter matches labels case-insensitively', () => {
    assert.deepStrictEqual(ids(modelOptions(catalog(), summary('s1'), [], 'SMALL')), ['fake-small']);
  });
  test('an unknown provider yields no rows', () => {
    assert.deepStrictEqual(modelOptions(catalog(), summary('s1', { providerId: 'nope', model: undefined }), []), []);
  });
});

suite('tui pickers: effort row', () => {
  test('offers the model levels with the saved one selected', () => {
    assert.deepStrictEqual(effortRow(catalog(), summary('s1', { effort: 'high' })), { levels: ['low', 'medium', 'high'], level: 'high' });
  });
  test('an invalid or missing saved level falls back to the model default', () => {
    assert.strictEqual(effortRow(catalog(), summary('s1', { model: 'fake-medium', effort: 'high' }))?.level, 'low');
    assert.strictEqual(effortRow(catalog(), summary('s1'))?.level, 'medium');
  });
  test('a model without effort has no row', () => {
    assert.strictEqual(effortRow(catalog(), summary('s1', { model: 'fake-small' })), undefined);
  });
  test('a single-level model still has a row', () => {
    const c = catalog();
    c[0]!.models[0]!.effort = { levels: ['high'], default: 'high' };
    assert.strictEqual(effortRow(c, summary('s1'))?.levels.length, 1);
  });
});

suite('tui pickers: mode options', () => {
  test('describes each mode and marks the current one', () => {
    const rows = modeOptions(catalog(), summary('s1', { permissionMode: 'plan' }), false);
    const plan = rows.find((r) => r.id === 'plan');
    assert.strictEqual(plan?.current, true);
    assert.strictEqual(plan?.label, 'Plan');
    assert.strictEqual((plan?.description.length ?? 0) > 0, true);
    assert.strictEqual(rows.filter((r) => r.current).length, 1);
  });
  test('bypass is disabled with a reason once the session has started', () => {
    const started = modeOptions(catalog(), summary('s1'), true).find((r) => r.id === 'bypass');
    assert.strictEqual(typeof started?.disabled, 'string');
    assert.strictEqual(modeOptions(catalog(), summary('s1'), false).find((r) => r.id === 'bypass')?.disabled, undefined);
  });
  test('only the modes a provider declares are offered', () => {
    const c = catalog();
    c[0]!.permissionModes = [{ id: 'default' }, { id: 'plan' }];
    assert.deepStrictEqual(ids(modeOptions(c, summary('s1'), false)), ['default', 'plan']);
  });
  test('OpenCode calls the default mode Build', () => {
    const c = catalog();
    c[0]!.id = 'opencode';
    assert.strictEqual(modeOptions(c, summary('s1', { providerId: 'opencode' }), false).find((r) => r.id === 'default')?.label, 'Build');
  });
});

suite('tui pickers: scroll window', () => {
  test('a short list is shown whole', () => {
    assert.deepStrictEqual(windowAround(3, 1, 8), { start: 0, end: 3 });
  });
  test('the window follows the cursor and never leaves the list', () => {
    assert.deepStrictEqual(windowAround(100, 0, 8), { start: 0, end: 8 });
    assert.deepStrictEqual(windowAround(100, 50, 8), { start: 46, end: 54 });
    assert.deepStrictEqual(windowAround(100, 99, 8), { start: 92, end: 100 });
  });
  test('an empty list has an empty window', () => {
    assert.deepStrictEqual(windowAround(0, 0, 8), { start: 0, end: 0 });
  });
});

suite('tui pickers: slash commands', () => {
  test('/model, /effort and /mode name their picker', () => {
    assert.strictEqual(parsePickerCommand('/model'), 'model');
    assert.strictEqual(parsePickerCommand('/effort'), 'effort');
    assert.strictEqual(parsePickerCommand('/mode'), 'mode');
  });
  test('/context names its dialog', () => {
    assert.strictEqual(parsePickerCommand('/context'), 'context');
    assert.strictEqual(parsePickerCommand(' /context '), 'context');
    assert.strictEqual(parsePickerCommand('/context now'), undefined);
  });
  test('surrounding space is ignored but extra words and other text are not commands', () => {
    assert.strictEqual(parsePickerCommand('  /model  '), 'model');
    assert.strictEqual(parsePickerCommand('/model gpt'), undefined);
    assert.strictEqual(parsePickerCommand('/models'), undefined);
    assert.strictEqual(parsePickerCommand('model'), undefined);
  });
});

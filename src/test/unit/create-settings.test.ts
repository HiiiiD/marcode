import * as assert from 'node:assert';
import { inheritedSettings, settingsForChoice } from '../../client-core/create-settings';
import { catalog, summary } from '../fixtures/protocol';

const withModes = () => {
  const [p] = catalog();
  return [{ ...p, permissionModes: [{ id: 'default' as const, label: 'Default' }, { id: 'acceptEdits' as const, label: 'Accept edits' }] }];
};

suite('create settings: choice inherits from the source session', () => {
  test('keeps effort and mode when the chosen model and provider allow them', () => {
    const state = { catalog: withModes(), sessions: [summary('s1', { effort: 'high', permissionMode: 'acceptEdits' })] };
    assert.deepStrictEqual(settingsForChoice(state, 's1', 'fake', 'fake-large'), {
      providerId: 'fake', model: 'fake-large', effort: 'high', mode: 'acceptEdits',
    });
  });
  test('effort falls back to the model default when its scale lacks the level', () => {
    const state = { catalog: withModes(), sessions: [summary('s1', { effort: 'high' })] };
    assert.strictEqual(settingsForChoice(state, 's1', 'fake', 'fake-medium')?.effort, 'low');
  });
  test('a mode the provider does not offer falls back to default', () => {
    const state = { catalog: catalog(), sessions: [summary('s1', { permissionMode: 'acceptEdits' })] };
    assert.strictEqual(settingsForChoice(state, 's1', 'fake', 'fake-large')?.mode, 'default');
  });
  test('no source session means catalog defaults; unknown provider yields nothing', () => {
    const state = { catalog: catalog(), sessions: [] };
    assert.deepStrictEqual(settingsForChoice(state, undefined, 'fake', 'fake-large'), {
      providerId: 'fake', model: 'fake-large', effort: 'medium', mode: 'default',
    });
    assert.strictEqual(settingsForChoice(state, undefined, 'nope', undefined), undefined);
  });
});

suite('create settings: inheritedSettings without DOM focus', () => {
  const pinned = (model: string) => summary('s1', { model });
  const layout = (focusedSessionId?: string) => ({
    root: { kind: 'leaf' as const, sessionId: 's1', size: 100 }, presets: [], focusedSessionId,
  });

  test('falls back to the pane in the layout instead of the catalog default', () => {
    const state = { catalog: catalog(), sessions: [pinned('fake-large')], focusedSessionId: null, layout: layout() };
    assert.strictEqual(inheritedSettings(state)?.model, 'fake-large');
  });
  test('an explicit focus still wins', () => {
    const state = {
      catalog: catalog(), sessions: [pinned('fake-large'), summary('s2', { model: 'fake-medium' })],
      focusedSessionId: 's2', layout: layout(),
    };
    assert.strictEqual(inheritedSettings(state)?.model, 'fake-medium');
  });
});

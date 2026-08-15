import * as assert from 'assert';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProviderInfo } from '../../protocol/messages';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { posted, renderApp, resetHost, sendFromHost } from './harness';

/** A second provider, so "grouped by provider" is testable at all. */
function twoProviders(): ProviderInfo[] {
  return [
    ...catalog(),
    {
      id: 'other',
      displayName: 'Other',
      models: [
        { id: 'other-one', displayName: 'Other One', effort: { levels: ['low', 'high'], default: 'high' } },
      ],
      permissionModes: [],
    },
  ];
}

function hydrate(sessions = [summary('a')], providers = catalog()) {
  sendFromHost({
    t: 'hydrate',
    sessions,
    layout: layoutOf(...sessions.map((s) => s.id)),
    snapshots: sessions.map((s) => snapshot(s.id, s)),
    catalog: providers,
    unavailable: [],
    usage: {},
  });
}

/**
 * Put focus in a pane's composer, which is what "the session I am working
 * in" means to the app: a real focus event through the real tree, exactly
 * what typing there produces.
 *
 * Not `userEvent.click`, only because react-resizable-panels' handle takes
 * the focus back under jsdom once a split has more than one pane — an
 * artifact of the test environment, not of the panel.
 */
function focusPane(index: number) {
  act(() => screen.getAllByRole('textbox', { name: 'Message' })[index].focus());
}

const newButton = () => screen.getAllByRole('button', { name: 'New session' })[0];
const optionsButton = () => screen.getAllByRole('button', { name: 'New session with options' })[0];

suite('SessionCreateMenu', () => {
  setup(() => resetHost());

  test('New creates a session inheriting the focused pane, with no menu in the way', async () => {
    renderApp();
    hydrate([summary('a', {
      model: 'fake-medium', effort: 'low', permissionMode: 'plan',
    })]);
    focusPane(0);

    await userEvent.click(newButton());

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-medium',
      effort: 'low',
      mode: 'plan',
    });
  });

  test('New inherits the focused pane, not the newest session', async () => {
    renderApp();
    hydrate([
      summary('a', { model: 'fake-medium', effort: 'low', permissionMode: 'plan', createdAt: 1 }),
      summary('b', { model: 'fake-large', effort: 'high', permissionMode: 'bypass', createdAt: 9 }),
    ]);
    // The second pane, deliberately: falling back to the roster's first
    // entry would also answer session 'a', so only focusing 'b' can tell
    // "inherits what I am working in" apart from "inherits the first thing".
    focusPane(1);

    await userEvent.click(newButton());

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-large',
      effort: 'high',
      mode: 'bypass',
    });
  });

  test('New falls back to the first catalog model before any pane is focused', async () => {
    renderApp();
    hydrate([]);

    await userEvent.click(newButton());

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-large',
      effort: 'medium',
      mode: 'default',
    });
  });

  test('an inherited effort the model no longer offers falls back to that model default', async () => {
    renderApp();
    // 'high' is on fake-large's scale but not fake-medium's, which is exactly
    // what a session carries after the catalog changes under it.
    hydrate([summary('a', { model: 'fake-medium', effort: 'high' })]);
    focusPane(0);

    await userEvent.click(newButton());

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'fake',
      cwd: '',
      model: 'fake-medium',
      effort: 'low',
      mode: 'default',
    });
  });

  test('a model with no effort scale creates without an effort', async () => {
    renderApp();
    hydrate([summary('a', { model: 'fake-small', effort: 'high' })]);
    focusPane(0);

    await userEvent.click(newButton());

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session', providerId: 'fake', cwd: '', model: 'fake-small', mode: 'default',
    });
  });

  test('the options modal groups models under their provider', async () => {
    renderApp();
    hydrate([summary('a')], twoProviders());

    await userEvent.click(optionsButton());

    const fake = await screen.findByRole('group', { name: 'Fake' });
    const other = screen.getByRole('group', { name: 'Other' });
    assert.ok(within(fake).getByRole('radio', { name: 'Fake Large' }));
    assert.ok(within(other).getByRole('radio', { name: 'Other One' }));
    assert.strictEqual(within(fake).queryByRole('radio', { name: 'Other One' }), null);
  });

  test('the modal creates with the chosen provider, model, effort and mode', async () => {
    renderApp();
    hydrate([summary('a')], twoProviders());

    await userEvent.click(optionsButton());
    await userEvent.click(await screen.findByRole('radio', { name: 'Other One' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'create-session',
      providerId: 'other',
      cwd: '',
      model: 'other-one',
      effort: 'high',
      mode: 'plan',
    });
  });

  test('the modal opens on the settings New would have inherited', async () => {
    renderApp();
    hydrate([summary('a', { model: 'fake-medium', effort: 'low', permissionMode: 'plan' })]);
    focusPane(0);

    await userEvent.click(optionsButton());

    assert.strictEqual(
      (await screen.findByRole('radio', { name: 'Fake Medium' })).getAttribute('aria-checked'),
      'true',
    );
    assert.strictEqual(
      screen.getByRole('radio', { name: 'Plan' }).getAttribute('aria-checked'),
      'true',
    );
  });

  test('cancelling the modal creates nothing', async () => {
    renderApp();
    hydrate();
    const before = posted().length;

    await userEvent.click(optionsButton());
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    assert.strictEqual(posted().length, before);
    assert.strictEqual(screen.queryByRole('dialog'), null);
  });

  test('both create controls are disabled when no provider is available', () => {
    renderApp();
    sendFromHost({
      t: 'hydrate',
      sessions: [],
      layout: { orientation: 'vertical', panes: [] },
      snapshots: [],
      catalog: [],
      unavailable: [],
      usage: {},
    });

    // Two of each control exist here: the roster's persistent pair and the
    // empty state's own (pane-group.tsx renders `<SessionCreateMenu />` when
    // the roster is empty). All must be disabled with no provider to create
    // against.
    const controls = [
      ...screen.getAllByRole('button', { name: 'New session' }),
      ...screen.getAllByRole('button', { name: 'New session with options' }),
    ];
    assert.strictEqual(controls.length, 4);
    for (const control of controls) {
      assert.ok((control as HTMLButtonElement).disabled);
    }
  });
});

import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsMdNudgeCard } from '@/components/agents-md-nudge-card';
import { posted, renderWithStore, resetHost, sendFromHost } from './harness';

function rendered(container: HTMLElement): boolean {
  return container.querySelector('div') !== null;
}

suite('AgentsMdNudgeCard', () => {
  setup(() => { resetHost(); });

  test('renders nothing when there are no hits', () => {
    const { container } = renderWithStore(<AgentsMdNudgeCard />);
    assert.strictEqual(rendered(container), false);
  });

  test('renders a row per hit, labelled by kind', () => {
    renderWithStore(<AgentsMdNudgeCard />);
    sendFromHost({
      t: 'agents-md-nudge',
      hits: [{ dir: 'pkg-a', kind: 'migrate' }, { dir: 'pkg-b', kind: 'add-stub' }],
    });

    assert.strictEqual(screen.getByText('pkg-a').tagName, 'SPAN');
    assert.strictEqual(screen.getByRole('button', { name: 'Migrate' }).tagName, 'BUTTON');
    assert.strictEqual(screen.getByRole('button', { name: 'Add stub' }).tagName, 'BUTTON');
  });

  test('clicking a row action posts agents-md-nudge-action for just that dir', async () => {
    renderWithStore(<AgentsMdNudgeCard />);
    sendFromHost({
      t: 'agents-md-nudge',
      hits: [{ dir: 'pkg-a', kind: 'migrate' }, { dir: 'pkg-b', kind: 'add-stub' }],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Migrate' }));

    const msg = posted().find((m) => m.t === 'agents-md-nudge-action');
    assert.deepStrictEqual(msg, { t: 'agents-md-nudge-action', action: 'migrate', dirs: ['pkg-a'] });
  });

  test('migrate all posts every listed dir', async () => {
    renderWithStore(<AgentsMdNudgeCard />);
    sendFromHost({
      t: 'agents-md-nudge',
      hits: [{ dir: 'pkg-a', kind: 'migrate' }, { dir: 'pkg-b', kind: 'add-stub' }],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Migrate all' }));

    const msg = posted().find((m) => m.t === 'agents-md-nudge-action');
    assert.deepStrictEqual(
      msg,
      { t: 'agents-md-nudge-action', action: 'migrate', dirs: ['pkg-a', 'pkg-b'] },
    );
  });

  test('a row error renders next to its path', () => {
    renderWithStore(<AgentsMdNudgeCard />);
    sendFromHost({
      t: 'agents-md-nudge',
      hits: [{ dir: 'pkg-a', kind: 'migrate', error: 'boom' }],
    });

    assert.strictEqual(screen.getByText('boom').tagName, 'SPAN');
  });
});

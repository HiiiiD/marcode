import { suite, test } from 'mocha';
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { renderFleet, resetHost, sendFromHost } from './fleet-harness';
import type { SessionSummary } from '../../protocol/messages';

suite('fleet view', () => {
  test('renders one card per roster session with its status', () => {
    resetHost();
    renderFleet();
    const sessions: SessionSummary[] = [
      makeSession({ id: 's1' as SessionSummary['id'], title: 'Alpha', status: 'running' }),
      makeSession({ id: 's2' as SessionSummary['id'], title: 'Beta', status: 'awaiting-approval' }),
    ];
    sendFromHost({
      t: 'hydrate', sessions, layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: [], unavailable: [], usage: {},
    });
    assert.strictEqual(screen.getByText('Alpha') !== undefined, true);
    assert.strictEqual(screen.getByText('Beta') !== undefined, true);
    assert.strictEqual(screen.getByText('Needs you') !== undefined, true);
  });

  test('a card renders the host-computed activityLabel wired from AgentSession', () => {
    resetHost();
    renderFleet();
    const sessions: SessionSummary[] = [
      makeSession({
        id: 's1' as SessionSummary['id'], title: 'Alpha', status: 'running',
        activityLabel: 'Running Edit',
      }),
    ];
    sendFromHost({
      t: 'hydrate', sessions, layout: { orientation: 'vertical', panes: [] },
      snapshots: [], catalog: [], unavailable: [], usage: {},
    });
    assert.strictEqual(screen.getByText('Running Edit') !== undefined, true);
  });
});

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 's0' as SessionSummary['id'], providerId: 'claude', model: 'test-model', title: 'Untitled',
    cwd: '/tmp', status: 'idle', permissionMode: 'default', includeEditorContext: false,
    resumeTokens: {}, usage: { inputTokens: 0, outputTokens: 0 }, archived: false,
    createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

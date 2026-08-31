// src/test/dom/fleet-app.test.tsx
import { suite, test } from 'mocha';
import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalog, layoutOf, snapshot, summary } from '../fixtures/protocol';
import { renderFleet, resetHost, sendFromHost } from './fleet-harness';
import type { TranscriptItem } from '../../protocol/messages';

function subagent(id: string, ts: number, state: 'running' | 'ok' | 'error', agent = 'Explore'): TranscriptItem {
  return {
    id, ts, role: 'tool', toolId: id,
    tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent },
    state, children: [],
  };
}

function hydrateWith(paneIds: string[], itemsBySession: Record<string, TranscriptItem[]> = {}) {
  sendFromHost({
    t: 'hydrate',
    sessions: paneIds.map((id) => summary(id)),
    layout: layoutOf(...paneIds),
    snapshots: paneIds.map((id) => snapshot(id, { items: itemsBySession[id] ?? [] })),
    catalog: catalog(),
    unavailable: [],
    usage: {},
  });
}

suite('FleetApp', () => {
  setup(() => { resetHost(); });

  test('forces a session pick before showing anything else', () => {
    renderFleet();
    hydrateWith(['a', 'b']);
    assert.strictEqual(screen.getByText(/pick a session/i) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('b').title) !== undefined, true);
  });

  test('an empty sidebar split says so, with no session to pick', () => {
    renderFleet();
    hydrateWith([]);
    assert.strictEqual(screen.getByText(/open one there first/i) !== undefined, true);
  });

  test('picking a session narrows to its running subagents by default', async () => {
    renderFleet();
    hydrateWith(['a'], {
      a: [subagent('s1', 1, 'running', 'Explore'), subagent('s2', 2, 'ok', 'Plan')],
    });
    await userEvent.click(screen.getByText(summary('a').title));

    assert.strictEqual(screen.getByText(/explore/i) !== undefined, true);
    assert.strictEqual(screen.queryByText(/plan/i) === null, true);
  });

  test('toggling reveals settled subagents too', async () => {
    renderFleet();
    hydrateWith(['a'], {
      a: [subagent('s1', 1, 'running', 'Explore'), subagent('s2', 2, 'ok', 'Plan')],
    });
    await userEvent.click(screen.getByText(summary('a').title));
    await userEvent.click(screen.getByRole('button', { name: /running only/i }));

    assert.strictEqual(screen.getByText(/explore/i) !== undefined, true);
    assert.strictEqual(screen.getByText(/plan/i) !== undefined, true);
  });

  test('opening a subagent shows its transcript, and back returns to the list, not the picker', async () => {
    renderFleet();
    hydrateWith(['a'], { a: [subagent('s1', 1, 'running', 'Explore')] });
    await userEvent.click(screen.getByText(summary('a').title));
    await userEvent.click(screen.getByText(/explore/i));

    assert.strictEqual(screen.getByText(/subagent:.*explore/i) !== undefined, true);

    // SubagentTranscript's own breadcrumb button is labelled "Back to
    // <title>" — the same session title used throughout this file.
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`back to ${summary('a').title}`, 'i') }));

    assert.strictEqual(screen.queryByText(/pick a session/i) === null, true);
    // Back from the transcript returns to the list (session still selected,
    // not all the way to the picker) — the row is visible again.
    assert.strictEqual(screen.getByText(/explore/i) !== undefined, true);
  });

  test('fleet-focus-subagent selects both the session and the subagent from the picker', () => {
    renderFleet();
    hydrateWith(['a'], { a: [subagent('s1', 1, 'running', 'Explore')] });
    // Still on the picker — nothing selected yet.
    assert.strictEqual(screen.getByText(/pick a session/i) !== undefined, true);

    sendFromHost({ t: 'fleet-focus-subagent', sessionId: 'a', itemId: 's1' });

    assert.strictEqual(screen.getByText(/subagent:.*explore/i) !== undefined, true);
  });

  test('layout-changed hides a pane the sidebar closed, without a fresh hydrate', () => {
    renderFleet();
    hydrateWith(['a', 'b']);
    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('b').title) !== undefined, true);

    // The sidebar's split dropped 'b' — Fleet's own PostBus registration
    // receives this echo (Task 2's FLEET_WANTS) the same way the sidebar
    // does, and the picker (driven by `state.layout`, not a cached list)
    // must reflect it without a full re-`ready`.
    sendFromHost({ t: 'layout-changed', layout: layoutOf('a') });

    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.queryByText(summary('b').title) === null, true);
  });

  test('a session added to the sidebar split after hydrate appears once its session-snapshot arrives', () => {
    renderFleet();
    hydrateWith(['a']);
    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.queryByText(summary('c').title) === null, true);

    // The sidebar's split grew to include 'c' — layout-changed alone puts the
    // pane in `layout.panes`, but SessionPicker also needs the matching
    // `byId` entry (it returns null for a pane with none), which only
    // session-snapshot creates outside hydrate.
    sendFromHost({ t: 'layout-changed', layout: layoutOf('a', 'c') });
    assert.strictEqual(screen.queryByText(summary('c').title) === null, true);

    sendFromHost({ t: 'session-snapshot', session: snapshot('c') });

    assert.strictEqual(screen.getByText(summary('a').title) !== undefined, true);
    assert.strictEqual(screen.getByText(summary('c').title) !== undefined, true);
  });
});

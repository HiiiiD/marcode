// The fleet diff surface, driven the way the host drives it: real
// StoreProvider, genuine HostToWebview messages, assertions reading what the
// webview posted back.

import * as assert from 'assert';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { posted, renderApp, resetHost, sendFromHost } from './harness';
import { resizeTo } from './setup';
import type { HostToWebview, TreeDiff } from '../../protocol/messages';

const TREE: TreeDiff = {
  root: '/repo', branch: 'feat-x', sessions: ['s1'],
  base: { kind: 'merge-base', ref: 'origin/main', sha: 'abc123' },
  files: [
    { path: 'src/a.ts', op: 'modify', insertions: 3, deletions: 1, claimedBy: ['s1'] },
    { path: 'src/orphan.ts', op: 'modify', insertions: 1, deletions: 0, claimedBy: [] },
  ],
  omitted: 0,
};

function hydrate(): HostToWebview {
  return {
    t: 'hydrate',
    sessions: [{
      id: 's1', title: 'Session one', providerId: 'fake', model: 'm',
      status: 'idle', cwd: '/repo', archived: false, updatedAt: 0,
    } as never],
    layout: { orientation: 'vertical', panes: [] },
    snapshots: [], catalog: [], unavailable: [], usage: {},
  };
}

async function openSurface(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /review changes/i }));
}

suite('fleet diff surface', () => {
  teardown(() => { cleanup(); resetHost(); });

  test('the entry point is absent below the review threshold', () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(400);
    assert.strictEqual(screen.queryAllByRole('button', { name: /review changes/i }).length, 0);
  });

  test('the entry point appears at the review threshold', () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    assert.strictEqual(screen.queryAllByRole('button', { name: /review changes/i }).length, 1);
  });

  test('opening the surface asks the host for a diff', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    assert.strictEqual(posted().some((m) => m.t === 'request-fleet-diff'), true);
  });

  test('a changed file is listed under the session that claimed it', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });

    assert.strictEqual(screen.getAllByText(/a\.ts/).length >= 1, true);
    assert.strictEqual(screen.getAllByText('Session one').length >= 1, true);
  });

  test('an unclaimed change is listed as unattributed', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });

    assert.strictEqual(screen.getAllByText(/not attributed/i).length >= 1, true);
  });

  test('clicking a file asks the host to open its diff', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });
    resetHost();

    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    const msg = posted().find((m) => m.t === 'open-file-diff');
    assert.strictEqual(msg?.t, 'open-file-diff');
    assert.strictEqual(msg?.t === 'open-file-diff' ? msg.path : '', 'src/a.ts');
  });

  test('the base is named, so a head-only diff cannot pass for a full one', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });

    assert.strictEqual(screen.getAllByText(/origin\/main/).length >= 1, true);
  });

  test('shrinking the panel while open falls back to the panes', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });
    resizeTo(400);

    assert.strictEqual(screen.queryAllByText(/not attributed/i).length, 0);
  });

  test('widening again restores it, because the intent was never cleared', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [TREE] });
    resizeTo(400);
    resizeTo(900);

    assert.strictEqual(screen.getAllByText(/not attributed/i).length >= 1, true);
  });

  test('an empty answer reads as nothing changed, not as nothing asked', async () => {
    renderApp();
    sendFromHost(hydrate());
    resizeTo(900);
    await openSurface();
    sendFromHost({ t: 'fleet-diff', trees: [] });

    assert.strictEqual(screen.getAllByText(/no changes/i).length >= 1, true);
  });
});

import * as assert from 'assert';
import { screen } from '@testing-library/react';
import { HostLinkBanner } from '@/components/host-link-banner';
import { renderWithStore, resetHost, sendFromHost } from './harness';

suite('HostLinkBanner', () => {
  setup(() => { resetHost(); });

  test('renders nothing while connected', () => {
    renderWithStore(<HostLinkBanner />);
    assert.strictEqual(screen.queryByRole('status') === null, true);
  });

  test('shows the reconnecting and lost copy, and clears on connected', async () => {
    renderWithStore(<HostLinkBanner />);
    sendFromHost({ t: 'host-link', status: 'reconnecting' });
    await screen.findByText(/Reconnecting to the background host/);
    sendFromHost({ t: 'host-link', status: 'lost' });
    await screen.findByText(/Lost the background host/);
    sendFromHost({ t: 'host-link', status: 'connected' });
    assert.strictEqual(screen.queryByRole('status') === null, true);
  });
});

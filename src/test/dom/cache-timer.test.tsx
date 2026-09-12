import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { CacheTimer } from '@/components/cache-timer';

suite('CacheTimer', () => {
  test('no window renders nothing', () => {
    render(<CacheTimer window={undefined} />);
    assert.strictEqual(screen.queryByRole('status', { name: /Prompt cache/ }), null);
  });

  test('a warm window shows minutes left and the full sentence as its title', () => {
    render(<CacheTimer window={{ anchorAt: Date.now(), ttlMs: 3_600_000 }} />);
    const el = screen.getByRole('status', { name: /Prompt cache warm/ });
    assert.strictEqual(el.textContent, '60m');
    assert.strictEqual(el.getAttribute('title'), 'Prompt cache warm, about 60 min left.');
  });

  test('an expired window drops the minute label but keeps the status', () => {
    render(<CacheTimer window={{ anchorAt: Date.now() - 3_700_000, ttlMs: 3_600_000 }} />);
    const el = screen.getByRole('status', { name: /Prompt cache likely expired/ });
    assert.strictEqual(el.textContent, '');
  });
});

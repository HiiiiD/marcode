import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { cn } from '@/lib/utils';

suite('dom harness smoke', () => {
  test('renders JSX into jsdom', () => {
    render(<div data-testid="probe" className={cn('p-2', 'p-4')}>hello</div>);
    assert.strictEqual(screen.getByTestId('probe').textContent, 'hello');
  });

  test('the @ alias resolves at runtime', () => {
    // cn is twMerge(clsx(...)) — the later padding wins.
    assert.strictEqual(cn('p-2', 'p-4'), 'p-4');
  });
});

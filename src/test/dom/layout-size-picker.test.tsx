import * as assert from 'assert';
import { render, screen, fireEvent } from '@testing-library/react';
import { LayoutSizePicker } from '../../webview/components/layout-size-picker';

suite('layout size picker', () => {
  test('a current layout wider than the grid still leaves one tab stop', () => {
    render(<LayoutSizePicker current={{ rows: 1, cols: 7 }} onPick={() => undefined} />);
    const stops = screen.getAllByRole('button').filter((b) => b.getAttribute('tabindex') === '0');
    assert.strictEqual(stops.length, 1);
    assert.strictEqual(stops[0].getAttribute('aria-label'), '1 row by 6 columns');
    assert.strictEqual(screen.getByText('1 × 7') !== null, true);
  });

  test('focus leaving the grid clears the highlight and readout', () => {
    render(<LayoutSizePicker current={null} onPick={() => undefined} />);
    const cell = screen.getByRole('button', { name: '2 rows by 3 columns' });
    fireEvent.focus(cell);
    assert.strictEqual(screen.getByText('2 × 3') !== null, true);
    fireEvent.focusOut(cell, { relatedTarget: null });
    assert.strictEqual(screen.getByText('Pick a size') !== null, true);
  });
});

import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { Markdown } from '@/components/markdown';

suite('Markdown', () => {
  test('renders fenced code as a pre, not as backticks', () => {
    const { container } = render(<Markdown>{'```ts\nconst a = 1;\n```'}</Markdown>);
    const pre = container.querySelector('pre');
    assert.ok(pre, 'a fenced block must become a <pre>');
    assert.ok(pre!.textContent!.includes('const a = 1;'));
    assert.ok(!container.textContent!.includes('```'));
  });

  test('renders lists as lists', () => {
    const { container } = render(<Markdown>{'- one\n- two'}</Markdown>);
    assert.strictEqual(container.querySelectorAll('li').length, 2);
  });

  test('never emits a remote resource', () => {
    const { container } = render(
      <Markdown>{'![x](https://evil.test/a.png)\n\n[link](https://evil.test)'}</Markdown>,
    );
    assert.strictEqual(container.querySelector('img'), null, 'CSP is default-src none');
    const anchor = container.querySelector('a');
    assert.strictEqual(anchor, null, 'links are rendered as plain text, not anchors');
    screen.getByText(/link/);
  });

  test('raw HTML in the stream is not parsed', () => {
    const { container } = render(<Markdown>{'<img src=x onerror=alert(1)>'}</Markdown>);
    assert.strictEqual(container.querySelector('img'), null);
  });
});

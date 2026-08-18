import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Markdown } from '@/components/markdown';
import { posted, renderWithStore, resetHost } from './harness';

suite('Markdown', () => {
  setup(() => resetHost());

  test('renders fenced code as a pre, not as backticks', () => {
    const { container } = renderWithStore(<Markdown>{'```ts\nconst a = 1;\n```'}</Markdown>);
    const pre = container.querySelector('pre');
    assert.ok(pre, 'a fenced block must become a <pre>');
    assert.ok(pre!.textContent!.includes('const a = 1;'));
    assert.ok(!container.textContent!.includes('```'));
  });

  test('renders lists as lists', () => {
    const { container } = renderWithStore(<Markdown>{'- one\n- two'}</Markdown>);
    assert.strictEqual(container.querySelectorAll('li').length, 2);
  });

  test('no heading level injects a real heading into the document outline', () => {
    const source = ['# one', '## two', '### three', '#### four', '##### five', '###### six'].join('\n\n');
    const { container } = renderWithStore(<Markdown>{source}</Markdown>);
    for (let level = 1; level <= 6; level += 1) {
      assert.strictEqual(
        container.querySelector(`h${level}`) === null, true,
        `h${level} must be downgraded to an emphasized paragraph, not a real heading`,
      );
    }
    for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) {
      screen.getByText(text);
    }
  });

  test('never emits a remote resource', () => {
    const { container } = renderWithStore(
      <Markdown>{'![x](https://evil.test/a.png)\n\n[link](https://evil.test)'}</Markdown>,
    );
    assert.strictEqual(container.querySelector('img') === null, true, 'CSP is default-src none');
    // A real anchor is still never emitted: an href in a `default-src 'none'`
    // webview is a navigation nothing services. The click goes to the host.
    assert.strictEqual(container.querySelector('a') === null, true, 'no anchor, no href');
  });

  test('an external link opens outside the editor', async () => {
    renderWithStore(<Markdown>{'see [the docs](https://example.test/a)'}</Markdown>);

    await userEvent.click(screen.getByRole('button', { name: /the docs/ }));

    assert.deepStrictEqual(
      posted().at(-1), { t: 'open-external', url: 'https://example.test/a' },
    );
  });

  test('a path link reveals the file at its line', async () => {
    renderWithStore(<Markdown>{'in [agent-session.ts](src/host/agent-session.ts#L601)'}</Markdown>);

    await userEvent.click(screen.getByRole('button', { name: /agent-session/ }));

    assert.deepStrictEqual(posted().at(-1), {
      t: 'reveal-file', path: 'src/host/agent-session.ts', startLine: 601,
    });
  });

  test('a link this panel cannot service stays plain text', () => {
    const { container } = renderWithStore(<Markdown>{'[nope](javascript:alert(1))'}</Markdown>);

    assert.strictEqual(container.querySelector('button') === null, true);
    screen.getByText(/nope/);
  });

  test('raw HTML in the stream is not parsed', () => {
    const { container } = renderWithStore(<Markdown>{'<img src=x onerror=alert(1)>'}</Markdown>);
    assert.strictEqual(container.querySelector('img') === null, true);
  });

  // Assistant text arrives token by token via session-patch deltas, so this
  // component re-renders on syntactically incomplete markdown mid-stream —
  // an unclosed fence or a list cut off after a dash. It must not throw.
  test('an unterminated fence renders without throwing', () => {
    assert.doesNotThrow(() => {
      renderWithStore(<Markdown>{'```ts\nconst a = 1;'}</Markdown>);
    });
  });

  test('a truncated list renders without throwing', () => {
    assert.doesNotThrow(() => {
      renderWithStore(<Markdown>{'- one\n- '}</Markdown>);
    });
  });

  test('a GFM table renders as a real table, not piped text', () => {
    const source = '| Task | State |\n|---|---|\n| a | done |';
    const { container } = renderWithStore(<Markdown>{source}</Markdown>);
    assert.strictEqual(container.querySelector('table') === null, false);
    assert.strictEqual(container.querySelectorAll('tbody tr').length, 1);
    assert.strictEqual(container.textContent!.includes('|'), false);
  });

  suite('table actions', () => {
    const source = '| Task | State |\n|---|---|\n| a | done |\n| b\tx | e"f |';
    let writeText: (text: string) => Promise<void>;
    let written: string[];

    setup(() => {
      written = [];
      writeText = async (text: string) => { written.push(text); };
      Object.assign(navigator, { clipboard: { writeText } });
    });

    test('copy writes the table as TSV', async () => {
      renderWithStore(<Markdown>{source}</Markdown>);

      await userEvent.click(screen.getByRole('button', { name: /copy table/i }));

      assert.deepStrictEqual(written, ['Task\tState\na\tdone\nb x\te"f']);
    });

    test('download posts the table as CSV to the host', async () => {
      renderWithStore(<Markdown>{source}</Markdown>);

      await userEvent.click(screen.getByRole('button', { name: /download table/i }));

      assert.deepStrictEqual(posted().at(-1), {
        t: 'export-table-csv',
        csv: 'Task,State\r\na,done\r\nb\tx,"e""f"',
      });
    });
  });

  test('copying a code block writes its text to the clipboard', async () => {
    const written: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    renderWithStore(<Markdown>{'```ts\nconst a = 1;\n```'}</Markdown>);

    await userEvent.click(screen.getByRole('button', { name: /copy code/i }));

    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].trim(), 'const a = 1;');
  });
});

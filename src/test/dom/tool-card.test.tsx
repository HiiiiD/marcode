import * as assert from 'assert';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCard } from '@/components/tool-card';
import { tool } from '../fixtures/protocol';
import { posted, renderWithStore } from './harness';

const expand = () => userEvent.click(screen.getByRole('button', { expanded: false }));

suite('ToolCard', () => {
  test('the collapsed row names the tool and its one telling argument', () => {
    renderWithStore(<ToolCard item={tool({
      tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' },
    })} />);

    screen.getByText('Bash');
    screen.getByText('yarn test:unit');
    // Nothing of the payload leaks before the row is opened.
    assert.strictEqual(document.querySelector('pre'), null);
  });

  test('expanding shows the command and the result under separate headings', async () => {
    renderWithStore(<ToolCard item={tool({
      tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' },
      output: { kind: 'text', text: '14 passing' },
    })} />);
    await expand();

    screen.getByText('Result');
    screen.getByText('14 passing');
    // The `$` gutter is decoration for a screen reader — the command reads on
    // its own, without a stray dollar sign glued to it.
    const gutter = screen.getByText('$');
    assert.strictEqual(gutter.getAttribute('aria-hidden'), 'true');
  });

  test('a failed call is named in words, not only in colour', async () => {
    renderWithStore(<ToolCard item={tool({
      tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' },
      state: 'error',
      output: { kind: 'text', text: 'ENOENT' },
    })} />);

    screen.getByText('failed');
    await expand();
    screen.getByText('Error');
    screen.getByText('ENOENT');
  });

  test('a running call reports itself rather than showing an empty result', async () => {
    renderWithStore(<ToolCard item={tool({
      tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' },
      state: 'running',
      output: undefined,
    })} />);
    await expand();

    screen.getByText('Running…');
    assert.strictEqual(screen.queryByText('Result'), null);
  });

  test('long output is clamped to its opening and its verdict until asked', async () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    renderWithStore(<ToolCard item={tool({
      tool: { kind: 'command', label: 'Bash', command: 'yarn test:unit' },
      output: { kind: 'text', text: output },
    })} />);
    await expand();

    screen.getByText('line 0');
    screen.getByText('line 99');
    assert.strictEqual(screen.queryByText('line 50'), null, 'the middle is what buries a transcript');

    await userEvent.click(screen.getByText('80 more lines'));
    screen.getByText('line 50');
  });

  test('an edit renders a diff, and its path opens the file', async () => {
    const item = tool({
      tool: {
        kind: 'file-edit', label: 'Edit',
        files: [{ path: '/repo/src/a.ts', op: 'modify', edits: [{ before: 'one', after: 'two' }] }],
      },
      output: { kind: 'text', text: 'ok' },
    });
    renderWithStore(<ToolCard item={item} />);
    await expand();

    screen.getByText('-one');
    screen.getByText('+two');

    // The row shows a shortened path; the full one is what the host gets.
    await userEvent.click(screen.getByTitle('/repo/src/a.ts'));
    assert.deepStrictEqual(posted().at(-1), { t: 'reveal-file', path: '/repo/src/a.ts' });
  });

  test('an mcp call names its tool and shows its server badge in the collapsed row', () => {
    const item = tool({
      tool: { kind: 'mcp', label: 'create_pr', server: 'github', tool: 'create_pr' },
      output: { kind: 'text', text: 'done' },
    });
    renderWithStore(<ToolCard item={item} />);

    screen.getByText('github');
    screen.getByText('create_pr');
  });

  // Exercises a genuine `other`-kind call — the fallback a provider's
  // classifier reaches for when nothing more specific fits — rather than the
  // shim that used to stand in for a missing `tool` field.
  test('an unserializable argument renders instead of throwing during a turn', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    renderWithStore(<ToolCard item={tool({
      tool: { kind: 'other', label: 'create_pr', raw: circular },
    })} />);

    screen.getByText('create_pr');
  });
});

import * as assert from 'assert';
import { render, screen } from '@testing-library/react';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';

suite('InputGroup', () => {
  test('renders a textarea and a block-end addon inside one group', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="Message" />
        <InputGroupAddon align="block-end"><span>addon</span></InputGroupAddon>
      </InputGroup>,
    );

    const textarea = screen.getByLabelText('Message');
    assert.strictEqual(textarea.tagName, 'TEXTAREA');

    const addon = screen.getByText('addon').closest('[data-slot="input-group-addon"]');
    assert.ok(addon, 'the addon must carry data-slot="input-group-addon"');
    assert.strictEqual(addon!.getAttribute('data-align'), 'block-end');
  });

  test('focus inside the group marks the group focused', () => {
    render(
      <InputGroup>
        <InputGroupTextarea aria-label="Message" />
      </InputGroup>,
    );
    const group = screen.getByLabelText('Message').closest('[data-slot="input-group"]')!;
    assert.ok(
      group.className.includes('focus-within:'),
      'the group, not the textarea, owns the focus ring',
    );
  });
});

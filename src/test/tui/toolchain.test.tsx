import { afterEach, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import { act, useState } from 'react';

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => { act(() => { setup?.renderer.destroy(); }); setup = undefined; });

function Counter() {
  const [n, setN] = useState(0);
  return (
    <box flexDirection="column">
      <text>{`count ${n}`}</text>
      <input focused onInput={() => setN((v) => v + 1)} />
    </box>
  );
}

test('the test renderer draws a frame and takes typed input', async () => {
  setup = await testRender(<Counter />, { width: 40, height: 6 });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('count 0');
  await act(async () => { await setup!.mockInput.typeText('ab'); });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain('count 2');
});

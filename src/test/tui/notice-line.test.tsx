import { afterEach, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import { NoticeLine } from '../../tui/ui/notice-line';
import { useTuiStore } from '../../tui/ui/store';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

let setter: ((t: string | null) => void) | undefined;
function Probe() {
  const { setNotice } = useTuiStore();
  useEffect(() => { setter = setNotice; }, [setNotice]);
  return <NoticeLine />;
}

test('renders the notice and clears with it', async () => {
  m = await mount(<Probe />);
  expect(m.frame()).not.toContain('restart to apply');
  await act(async () => { setter?.('restart to apply config changes'); });
  await m.setup.renderOnce();
  expect(m.frame()).toContain('restart to apply config changes');
  await act(async () => { setter?.(null); });
  await m.setup.renderOnce();
  expect(m.frame()).not.toContain('restart to apply');
});

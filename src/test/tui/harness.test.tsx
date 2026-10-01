import { useKeyboard } from '@opentui/react';
import { afterEach, expect, test } from 'bun:test';
import { useState } from 'react';
import { mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

function Probe() {
  const [seen, setSeen] = useState('');
  useKeyboard((k) => {
    setSeen(`${k.name}|ctrl=${k.ctrl}|meta=${k.meta}|shift=${k.shift}|seq=${JSON.stringify(k.sequence)}`);
  });
  return <text>{`seen:${seen}`}</text>;
}

async function seenAfter(name: string, mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean }) {
  m = await mount(<Probe />, { width: 120, height: 5 });
  await m.press(name, mods);
  const line = m.frame().split('\n').find((l) => l.includes('seen:')) ?? '';
  const out = line.trim();
  m.destroy();
  m = undefined;
  return out;
}

// OpenTUI reports Ctrl+J as the raw linefeed byte: name 'linefeed', ctrl false, never name 'j'.
const cases: [string, { ctrl?: boolean; meta?: boolean; shift?: boolean } | undefined, string][] = [
  ['pageup', undefined, 'seen:pageup|'],
  ['pagedown', undefined, 'seen:pagedown|'],
  ['space', undefined, 'seen:space|'],
  ['end', undefined, 'seen:end|'],
  ['backspace', undefined, 'seen:backspace|'],
  ['tab', { shift: true }, 'seen:tab|ctrl=false|meta=false|shift=true'],
  ['return', { meta: true }, 'seen:return|ctrl=false|meta=true'],
  ['j', { ctrl: true }, 'seen:linefeed|ctrl=false'],
];

for (const [name, mods, expected] of cases) {
  test(`press(${name}${mods ? ', ' + JSON.stringify(mods) : ''}) reaches useKeyboard as ${expected}`, async () => {
    const got = await seenAfter(name, mods);
    expect(got.startsWith(expected)).toBe(true);
  });
}

import { afterEach, expect, test } from 'bun:test';
import { catalog } from '../fixtures/protocol';
import { NewSessionDialog } from '../../tui/ui/new-session-dialog';
import { hydrateMsg, mount, type Mounted } from './harness';

let m: Mounted | undefined;
afterEach(() => { m?.destroy(); m = undefined; });

const oneModel = () => { const c = catalog(); c[0].models = [c[0].models[0]]; return c; };
const creates = () => (m?.posted ?? []).filter((p) => p.t === 'create-session');

test('Enter on a one-model provider creates with the launch cwd and no seed', async () => {
  let created = 0;
  m = await mount(<NewSessionDialog cwd="/repo/pkg" onClose={() => {}} onCreated={() => { created++; }} />);
  await m.fromHost(hydrateMsg({ catalog: oneModel() }));
  expect(m.frame()).toContain('New session');
  await m.press('return');
  const msg = creates()[0];
  expect(msg?.t === 'create-session' && msg.providerId).toBe('fake');
  expect(msg?.t === 'create-session' && msg.model).toBe('fake-large');
  expect(msg?.t === 'create-session' && msg.cwd).toBe('/repo/pkg');
  expect(msg !== undefined && 'seed' in msg).toBe(false);
  expect(created).toBe(1);
});

test('several models go through a model step; Enter picks the highlighted one', async () => {
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg());
  await m.press('return');
  expect(creates().length).toBe(0);
  expect(m.frame()).toContain('Fake Small');
  await m.press('j');
  await m.press('return');
  const msg = creates()[0];
  expect(msg?.t === 'create-session' && msg.model).toBe('fake-small');
});

test('batched down and Enter pick the moved option', async () => {
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg());
  await m.press('return');
  await m.pressMany(['down', 'return']);
  expect(creates().length).toBe(1);
  const msg = creates()[0];
  expect(msg?.t === 'create-session' && msg.model).toBe('fake-small');
});

test('batched Enter Enter posts once', async () => {
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg({ catalog: oneModel() }));
  await m.pressMany(['return', 'return']);
  expect(creates().length).toBe(1);
});

test('Esc closes without creating, from the model step', async () => {
  let closed = 0;
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => { closed++; }} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg());
  await m.press('return');
  await m.press('escape');
  await new Promise((r) => setTimeout(r, 100));
  await m.setup.renderOnce();
  expect(closed).toBe(1);
  expect(creates().length).toBe(0);
});

test('Esc closes without creating, from the provider step', async () => {
  let closed = 0;
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => { closed++; }} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg());
  await m.press('escape');
  await new Promise((r) => setTimeout(r, 100));
  await m.setup.renderOnce();
  expect(closed).toBe(1);
  expect(creates().length).toBe(0);
});

test('the initial prompt is passed as the seed', async () => {
  m = await mount(<NewSessionDialog cwd="/r" initialPrompt="fix it" onClose={() => {}} onCreated={() => {}} />);
  await m.fromHost(hydrateMsg({ catalog: oneModel() }));
  await m.press('return');
  const msg = creates()[0];
  expect(msg?.t === 'create-session' && msg.seed?.text).toBe('fix it');
});

test('an empty catalog says so and Enter does nothing', async () => {
  let created = 0;
  m = await mount(<NewSessionDialog cwd="/r" onClose={() => {}} onCreated={() => { created++; }} />);
  await m.fromHost(hydrateMsg({ catalog: [] }));
  expect(m.frame()).toContain('No provider available.');
  await m.press('return');
  expect(creates().length).toBe(0);
  expect(created).toBe(0);
});

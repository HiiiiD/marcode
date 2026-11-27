#!/usr/bin/env node
// Device sync end to end, in Docker: a sync server and two device containers ("desk", "laptop"),
// each a real host with its own disk, driven over HTTP. Usage: node scripts/sync-e2e/run.mjs [--keep]
import { execFileSync, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keep = process.argv.includes('--keep');
const SERVER = 'http://10.77.0.10:8787';
const desk = 'http://127.0.0.1:17001';
const laptop = 'http://127.0.0.1:17002';
const compose = (...args) => execFileSync('docker', ['compose', '-f', path.join(here, 'compose.yml'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const t0 = Date.now();
const log = (s) => { console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`); };

async function call(base, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) { throw new Error(`${method} ${base}${route}: ${json?.error ?? res.status}`); }
  return json;
}
const get = (b, r) => call(b, 'GET', r);
const post = (b, r, body = {}) => call(b, 'POST', r, body);

async function until(what, probe, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try { last = await probe(); if (last) { return last; } } catch (err) { last = err.message; }
    await sleep(500);
  }
  throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)})`);
}

async function step(name, work) {
  try { await work(); log(`PASS  ${name}`); } catch (err) { failures++; log(`FAIL  ${name}: ${err.message}`); }
}

const row = async (base, id) => (await get(base, '/sessions')).find((s) => s.id === id);
const texts = async (base, id) => (await get(base, `/items?id=${id}`)).map((i) => i.text).filter(Boolean);

log('building the driver and images');
execFileSync('node', [path.join(here, 'build.mjs')], { stdio: 'inherit' });
spawnSync('docker', ['compose', '-f', path.join(here, 'compose.yml'), 'down', '-v'], { stdio: 'ignore' });
compose('up', '-d', '--build');
try {
  await until('both drivers up', async () => (await get(desk, '/health')) && (await get(laptop, '/health')), 60_000);
  const code = await until('the bootstrap code', async () => /MRB-[0-9A-Z-]+/.exec(compose('logs', 'server'))?.[0]);

  await step('desk enrolls, laptop joins with a pairing code, both hosts start', async () => {
    await post(desk, '/enroll', { server: SERVER, code });
    const { code: pairing } = await post(desk, '/pair');
    await post(laptop, '/join', { server: SERVER, code: pairing });
    await post(desk, '/start');
    await post(laptop, '/start');
  });

  let live;
  await step("laptop lists desk's session, read-only, and follows it live", async () => {
    ({ id: live } = await post(desk, '/session', { text: 'zebra migration plan for the billing service' }));
    await until('remote row on laptop', async () => (await row(laptop, live))?.remote?.deviceName === 'desk');
    await until('first message on laptop', async () => (await texts(laptop, live)).includes('zebra migration plan for the billing service'));
    await post(desk, '/send', { id: live, text: 'second turn, written on desk' });
    await until('second message on laptop', async () => (await texts(laptop, live)).includes('second turn, written on desk'), 15_000);
  });

  await step("a session closed on desk is found by laptop's recall", async () => {
    await post(desk, '/close', { id: live });
    await until('recall hit on laptop', async () => (await get(laptop, '/recall?q=zebra billing')).includes(live), 40_000);
  });

  let moved;
  await step('a session moves from desk to laptop and continues there', async () => {
    ({ id: moved } = await post(desk, '/session', { text: 'please move me to the laptop' }));
    await until('remote row on laptop', async () => (await row(laptop, moved))?.remote);
    const panel = await get(laptop, `/panel?id=${moved}`);
    if (panel.mode !== 'move') { throw new Error(`panel mode ${panel.mode}: ${panel.reason ?? ''}`); }
    await post(laptop, '/move', { id: moved });
    const done = await until('move done', async () => {
      const seen = await get(laptop, `/move?id=${moved}`);
      const last = seen.at(-1);
      if (last?.state === 'failed') { throw new Error(last.reason); }
      return last?.state === 'done' ? last : undefined;
    }, 60_000);
    if ((await row(laptop, moved))?.remote) { throw new Error('still remote on laptop'); }
    await post(laptop, '/send', { id: moved, text: 'continuing on the laptop' });
    await until('desk lists it as laptop\'s', async () => (await row(desk, moved))?.remote?.deviceName === 'laptop', 30_000);
    await until('desk sees the laptop turn', async () => (await texts(desk, moved)).includes('continuing on the laptop'), 30_000);
    log(`      thread: ${done.thread}`);
  });

  let taken;
  await step('desk dies with unsent work; laptop takes over; desk comes back and keeps it as a fork', async () => {
    ({ id: taken } = await post(desk, '/session', { text: 'work that will be taken over' }));
    await until('remote row on laptop', async () => (await row(laptop, taken))?.remote);
    await sleep(3000);
    compose('stop', 'server');
    await post(desk, '/send', { id: taken, text: 'written while the server was down' });
    compose('stop', 'desk');
    compose('start', 'server');
    log('      waiting out the 1-minute take-over threshold');
    await until('take over offered', async () => (await get(laptop, `/panel?id=${taken}`)).mode === 'take-over', 150_000);
    await post(laptop, '/move', { id: taken, takeOver: true });
    await until('take over done', async () => {
      const last = (await get(laptop, `/move?id=${taken}`)).at(-1);
      if (last?.state === 'failed') { throw new Error(last.reason); }
      return last?.state === 'done';
    }, 60_000);
    const notice = (await texts(laptop, taken)).at(-1) ?? '';
    if (!notice.startsWith('Taken over from desk')) { throw new Error(`notice: ${notice}`); }
    compose('start', 'desk');
    await until('desk driver back', async () => (await get(desk, '/health')).started, 60_000);
    const fork = await until('fork on desk', async () => (await get(desk, '/sessions')).find((s) => s.origin === 'fork' && s.parentId === taken), 60_000);
    const forkTexts = await texts(desk, fork.id);
    if (!forkTexts.includes('written while the server was down')) { throw new Error(`fork lacks the offline turn: ${JSON.stringify(forkTexts)}`); }
    await until("desk shows the original as laptop's", async () => (await row(desk, taken))?.remote?.deviceName === 'laptop', 30_000);
    log(`      fork: "${fork.title}"`);
  });

  await step('a session deleted on laptop disappears from desk', async () => {
    await post(laptop, '/delete', { id: moved });
    await until('gone on desk', async () => !(await row(desk, moved)), 30_000);
  });
} catch (err) {
  failures++;
  log(`ABORT ${err.message}`);
} finally {
  if (failures > 0) { for (const s of ['desk', 'laptop', 'server']) { console.log(`--- ${s} logs (tail) ---\n${compose('logs', '--tail', '40', s)}`); } }
  if (!keep) { spawnSync('docker', ['compose', '-f', path.join(here, 'compose.yml'), 'down', '-v'], { stdio: 'ignore' }); }
}
log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

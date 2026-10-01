import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootHost, type Booted } from '../../tui/boot';

let booted: Booted | undefined;
let tmp: string | undefined;
afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  if (tmp) { await fs.rm(tmp, { recursive: true, force: true }); tmp = undefined; }
});

test('under Bun memory is forced off without a launch warning', async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mar-bunboot-')));
  const notified: string[] = [];
  booted = await bootHost({
    cwd: tmp, home: path.join(tmp, 'home'), notify: (m) => { notified.push(m); },
    config: { enabledProviders: ['fake'], memory: { enabled: true, summarizer: undefined } },
  });
  expect(booted.warnings).toEqual([]);
  expect(notified).toEqual([]);
});

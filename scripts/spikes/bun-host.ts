// throwaway spike. run: bun scripts/spikes/bun-host.ts
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const results: Record<string, string> = {};
async function probe(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { results[name] = `ok ${String((await fn()) ?? '')}`.trim(); }
  catch (err) { results[name] = `FAIL ${(err as Error).message}`; }
}

await probe('runtime', async () => (process.versions as Record<string, string>).bun ?? 'not bun');
await probe('node:sqlite fts5', async () => {
  const { DatabaseSync } = await import(['node', 'sqlite'].join(':'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
  db.close();
});
await probe('acp sdk (esm import)', async () => { await import('@agentclientprotocol/sdk'); });
await probe('opencode sdk', async () => { await import('@opencode-ai/sdk/v2'); });
await probe('claude agent sdk', async () => { await import('@anthropic-ai/claude-agent-sdk'); });

for (const memory of [true, false]) {
  await probe(`createHost fake, memory=${memory}`, async () => {
    const { createHost } = await import('../../src/host/create-host');
    const { defaultHostConfig } = await import('../../src/host/host-config');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-bun-'));
    const host = await createHost({
      workspaceDir: dir, hostKind: 'tui', workspaceRoots: () => [dir], emit: () => {},
      notify: { warn: (m) => { results[`warn:${m.slice(0, 40)}`] = m; } },
      config: { ...defaultHostConfig(), enabledProviders: ['fake'], memory: { enabled: memory, summarizer: undefined } },
    });
    await host.init();
    const s = await host.manager.create('fake', dir);
    s.send('hello');
    await new Promise((r) => setTimeout(r, 300));
    const text = JSON.stringify(await s.snapshot());
    await host.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    return text.includes('"ok"') ? 'turn streamed' : 'no reply in snapshot';
  });
}
console.log(JSON.stringify(results, null, 2));

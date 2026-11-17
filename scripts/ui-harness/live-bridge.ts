// Live harness: a real Marcode host (the same createHost the daemon runs) with the scripted FakeProvider,
// bridged to the browser over HTTP + server-sent events, so the real webview bundle can be watched mid-turn.
//   npx tsx scripts/ui-harness/live-bridge.ts [port]      then open http://127.0.0.1:4175/live?theme=dark
// Everything lives in a throwaway MARCODE_HOME; no real session or account is touched.
// Put `scenario:<name>` in a prompt: slow | quiet | permission | perm-edit | perm-mcp | perm-meta | perm-plan | question | error (anything else answers "ok").
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { bootHost, type InProcessBooted } from '../../src/tui/boot';
import type { FakeProvider, FakeRun } from '../../src/providers/fake/fake-provider';
import type { ToolCall } from '../../src/providers/canonical/tool-call';
import type { PermissionMeta } from '../../src/providers/types';
import type { HostToWebview, WebviewToHost } from '../../src/protocol/messages';

const port = Number(process.argv[2] ?? 4175);
const types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.html': 'text/html' };
const harnessDir = join(process.cwd(), 'scripts', 'ui-harness');
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

type Step = (run: FakeRun) => Promise<void>;
const text = (delta: string): Step => async (run) => run.emit({ kind: 'text', delta });
const think = (delta: string): Step => async (run) => run.emit({ kind: 'thinking', delta });
const wait = (ms: number): Step => () => sleep(ms);
const end = (reason: 'done' | 'interrupted' | 'error', error?: string): Step => async (run) => run.emit({ kind: 'turn-end', reason, ...(error ? { error } : {}) });
const tool = (id: string, command: string, ms: number, output: string): Step => async (run) => {
  run.emit({ kind: 'tool-start', id, tool: { kind: 'command', label: 'Bash', command } });
  await sleep(ms);
  run.emit({ kind: 'tool-end', id, ok: true, output: { kind: 'text', text: output } });
};
const ask = (toolCall: ToolCall, meta?: PermissionMeta): Step => async (run) => run.emit({ kind: 'permission', id: `p-${Date.now()}`, tool: toolCall, ...(meta ? { meta } : {}) });
const stream = (words: string[], gap = 250): Step => async (run) => {
  for (const w of words) { run.emit({ kind: 'text', delta: `${w} ` }); await sleep(gap); }
};

const SCENARIOS: Record<string, Step[]> = {
  slow: [
    think('Looking at how the transcript renders while a turn is running. '), wait(3000),
    tool('t1', 'yarn test:dom', 4000, '620 passing'), wait(2500),
    text('Checked. '), stream('The activity line names the step and stays for the whole turn.'.split(' ')), end('done'),
  ],
  quiet: [think('Thinking for a long while. '), wait(65_000), text('Done after a long silence.'), end('done')],
  permission: [
    think('I need to push. '), wait(1500),
    async (run) => run.emit({ kind: 'permission', id: `p-${Date.now()}`, tool: { kind: 'command', label: 'Bash', command: 'git push --force origin main' } }),
  ],
  'perm-edit': [ask({ kind: 'file-edit', label: 'Edit', files: [{ path: '/repo/src/webview/components/permission-card.tsx', op: 'modify', edits: [{ before: 'border-2 border-destructive', after: 'border border-attention/60' }] }] })],
  'perm-mcp': [ask({ kind: 'mcp', label: 'github', server: 'github', tool: 'create_pull_request', input: { owner: 'acme', repo: 'app', title: 'Fix header', base: 'main' } })],
  'perm-meta': [ask(
    { kind: 'command', label: 'Bash', command: 'rm -rf node_modules dist out .vscode-test && yarn install --frozen-lockfile && yarn run compile && yarn test:unit && yarn test:dom && git status --short' },
    { title: 'Run a destructive shell command', description: 'Deletes build output, then reinstalls.', decisionReason: 'Command matches a protected pattern (rm -rf)', blockedPath: '/repo/node_modules' },
  )],
  'perm-plan': [ask({ kind: 'plan', label: 'ExitPlanMode', text: '## Plan\n\n1. Add a pinned activity line\n2. Move it above the composer\n3. Add tests' })],
  question: [async (run) => run.emit({
    kind: 'question', id: `q-${Date.now()}`, blocking: true,
    questions: [{ id: 'q1', header: 'Layout', question: 'Where should the activity line live?', multiSelect: false, allowOther: true,
      options: [{ label: 'Above the composer', description: 'Pinned, never shifts the transcript' }, { label: 'In the header', description: 'No row at all' }] }],
  })],
  error: [think('Starting. '), wait(1500), end('error', 'Provider process exited unexpectedly (code 1)')],
};

function runScenario(prompt: string, run: FakeRun): void {
  const name = /scenario:([\w-]+)/.exec(prompt)?.[1];
  const steps = name ? SCENARIOS[name] : undefined;
  if (!steps) { run.emit({ kind: 'text', delta: 'ok' }); run.emit({ kind: 'turn-end', reason: 'done' }); return; }
  void (async () => { for (const step of steps) { await step(run); } })();
}

async function main(): Promise<void> {
const home = await mkdtemp(join(tmpdir(), 'marcode-live-'));
  const booted = await bootHost({
    cwd: process.cwd(), home, inProcess: true, notify: () => {},
    config: { enabledProviders: ['fake'], memory: { enabled: false } } as never,
  }) as InProcessBooted;

  const fake = booted.host.providers.get('fake') as FakeProvider;
  // The provider's own script answers instantly; the scenarios drive the run themselves instead.
  (fake as unknown as { script: (t: string) => [] }).script = (prompt) => {
    const run = fake.runs.at(-1);
    if (run) { setImmediate(() => runScenario(prompt, run)); }
    return [];
  };

  const clients = new Set<(msg: HostToWebview) => void>();
  booted.loopback.transport.onMessage((msg) => { for (const send of clients) { send(msg); } });

  const readBody = (req: import('node:http').IncomingMessage) => new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
  });

  const file = (p: string): string | null => {
    if (p === '/live') { return join(harnessDir, 'live.html'); }
    if (p === '/theme.css' || p === '/live.js') { return join(harnessDir, p.slice(1)); }
    if (p.startsWith('/dist/')) { return join('dist', normalize(p.slice(6)).replace(/^(\.\.[\\/])+/, '')); }
    return null;
  };

  createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const send = (msg: HostToWebview) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
      clients.add(send);
      res.write(': open\n\n');
      req.on('close', () => clients.delete(send));
      return;
    }
    if (path === '/post' && req.method === 'POST') {
      booted.loopback.transport.post(JSON.parse(await readBody(req)) as WebviewToHost);
      res.writeHead(204).end();
      return;
    }
    const target = file(path);
    if (!target) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': types[extname(target)] ?? 'text/plain', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  }).listen(port, '127.0.0.1', () => console.log(`live harness http://127.0.0.1:${port}/live  (home ${home})`));

  const stop = async () => { await booted.shutdown().catch(() => {}); await rm(home, { recursive: true, force: true }).catch(() => {}); process.exit(0); };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  
}

void main();

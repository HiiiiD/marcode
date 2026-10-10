import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import * as frames from '../fixtures/opencode-acp-frames.json';
import { isBusy } from '../../daemon/idle-monitor';
import { AgentSession, type SessionSink } from '../../host/agent-session';
import { TranscriptStore } from '../../host/transcript-store';
import type { SessionState } from '../../protocol/messages';
import { AcpRun } from '../../providers/acp/acp-run';
import { ClaudeProvider } from '../../providers/claude/claude-provider';
import { AppServer } from '../../providers/codex/app-server';
import { CodexRun } from '../../providers/codex/codex-run';
import { openCodeModeId } from '../../providers/opencode/map-modes';
import { openCodeTools } from '../../providers/opencode/map-tools';
import type { AgentProvider, AgentRun } from '../../providers/types';

const sink: SessionSink = {
  patch: () => {}, status: () => {}, mcp: () => {}, cacheWindow: () => {}, changed: () => {},
  invocables: () => {}, usageWindows: () => {},
};

const state = (providerId: string): SessionState => ({
  id: 's1', providerId, model: 'm', effort: 'medium', title: 'Untitled', name: 'Untitled', cwd: '/w',
  status: 'idle', permissionMode: 'default', includeEditorContext: false, resumeTokens: {}, createdAt: 1, updatedAt: 1,
});

/** Hands AgentSession a run the test already holds the far end of. */
const holding = (id: string, run: AgentRun): AgentProvider => ({
  id, displayName: id, threadScope: 'cwd',
  listModels: () => [], listPermissionModes: () => [{ id: 'default' }],
  start: () => run,
});

const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise((r) => setImmediate(r)); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the daemon's idle monitor reads. */
const daemonBusy = (s: AgentSession) => isBusy([{ status: s.state.status }]);

suite('daemon busy: background work per provider', () => {
  let dir: string;
  let store: TranscriptStore;
  let sessions: AgentSession[];
  let teardownHooks: Array<() => void>;

  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-busy-'));
    store = new TranscriptStore(dir);
    sessions = [];
    teardownHooks = [];
  });
  teardown(async () => {
    for (const h of teardownHooks) { h(); }
    for (const s of sessions) { await s.dispose(); }
    await fs.rm(dir, { recursive: true, force: true });
  });

  const session = (providerId: string, provider: AgentProvider) => {
    const s = new AgentSession(state(providerId), provider, store, sink);
    sessions.push(s);
    return s;
  };

  test('Claude: a background task still live after turn-end keeps the session busy', async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const queryFn = () => {
      const gen = (async function* () {
        yield {
          type: 'system', subtype: 'background_tasks_changed',
          tasks: [{ task_id: 'bg-1', task_type: 'agent', description: 'Investigating' }], uuid: 'u1', session_id: 'c1',
        };
        yield { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 }, uuid: 'u2', session_id: 'c1' };
        await released;
      })() as AsyncGenerator<unknown, void> & Record<string, unknown>;
      Object.assign(gen, {
        interrupt: async () => undefined, setPermissionMode: async () => {}, applyFlagSettings: async () => {},
        close: () => { release(); }, mcpServerStatus: async () => [], stopTask: async () => {},
      });
      return gen;
    };
    const s = session('claude', new ClaudeProvider((async () => queryFn) as never));
    s.send('kick off a background agent');
    await settle();
    assert.strictEqual(s.state.status, 'running');
    assert.strictEqual(daemonBusy(s), true);
  });

  test('Codex: a subagent thread still running after the parent turn completes keeps the session busy', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = new AppServer({ stdin, stdout, kill: () => {} });
    const notify = (method: string, params: unknown) => { stdout.write(`${JSON.stringify({ method, params })}
`); };
    const run = new CodexRun(server, { cwd: '/w', permissionMode: 'default', sessionId: 's1' });
    const s = session('codex', holding('codex', run));
    // An unanswered thread/unsubscribe would otherwise hold the teardown's dispose() open.
    teardownHooks.push(() => server.close('test done'));
    s.send('delegate to a subagent');
    await settle();
    server.ingest(`${JSON.stringify({ id: 1, result: { thread: { id: 'th_1' } } })}
`);
    await settle();
    notify('item/started', { threadId: 'th_1', item: { type: 'subAgentActivity', id: 'sa_1', kind: 'started', agentThreadId: 'th_child', agentPath: 'reviewer' } });
    notify('turn/completed', { threadId: 'th_1', turn: {} });
    await settle();
    assert.strictEqual(s.state.status, 'running');
    assert.strictEqual(daemonBusy(s), true);

    notify('turn/completed', { threadId: 'th_child', turn: {} });
    await settle();
    assert.strictEqual(s.state.status, 'idle');
    assert.strictEqual(daemonBusy(s), false);
  });

  // Assumes `opencode acp` has no work left after it answers the prompt with end_turn: its task subagents
  // run inside the prompt call, so there is no post-turn background work to report.
  test('OpenCode: a task subagent holds the turn open, so the session stays busy until it returns (no work after end_turn)', async () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const sent: Record<string, unknown>[] = [];
    toAgent.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) { if (line.trim()) { sent.push(JSON.parse(line)); } }
    });
    const emit = (frame: unknown) => { toClient.write(`${JSON.stringify(frame)}\n`); };
    const answer = async (method: string) => {
      for (let i = 0; i < 200 && !sent.some((f) => f.method === method); i++) { await wait(5); }
      const f = sent.find((x) => x.method === method);
      assert.strictEqual(f !== undefined, true, `no ${method} was sent`);
      return f as Record<string, unknown>;
    };
    const run = new AcpRun({ stdin: toAgent, stdout: toClient, kill: () => { toClient.end(); } }, {
      cwd: '/w', permissionMode: 'default', tools: openCodeTools, modeId: openCodeModeId,
      clientName: 'mar-code', sessionId: 's1',
    });
    const s = session('opencode', holding('opencode', run));
    const init = await answer('initialize');
    emit({ jsonrpc: '2.0', id: init.id, result: frames.initialize });
    const created = await answer('session/new');
    emit({ jsonrpc: '2.0', id: created.id, result: frames.newSession });
    const mode = await answer('session/set_mode');
    emit({ jsonrpc: '2.0', id: mode.id, result: {} });
    s.send('delegate to a subagent');
    const prompt = await answer('session/prompt');
    const sid = 'ses_ff0400c8affe2kYFjqc6OUHpG3';
    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
      sessionUpdate: 'tool_call', toolCallId: 'call_task_1', kind: 'think', title: 'Task', status: 'in_progress',
      rawInput: { description: 'look around', subagent_type: 'general', prompt: 'go' },
    } } });
    await wait(30);
    assert.strictEqual(s.state.status, 'running');
    assert.strictEqual(daemonBusy(s), true);

    emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'call_task_1', status: 'completed',
      rawOutput: { output: 'done', metadata: { sessionId: 'child_1', parentSessionId: sid } },
    } } });
    emit({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await wait(30);
    assert.strictEqual(s.state.status, 'idle');
    assert.strictEqual(daemonBusy(s), false);
  });
});

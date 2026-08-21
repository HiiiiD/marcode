# Self-control tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent running inside a Marcode session call a `marcode__spawn_session`
tool that creates a new session (provider/model/mode/cwd) and hands it an initial prompt
— for all three backends this project runs today (Claude Agent SDK, Codex, OpenCode).

**Architecture:** One loopback HTTP MCP server, owned by the extension host, started at
`activate()`. Every provider gets the server's `{url, token}` at construction and adds it
to whatever MCP-server wiring it already uses to reach its backend — the Claude Agent
SDK's `mcpServers` option, ACP's `NewSessionRequest.mcpServers` (OpenCode), and Codex
app-server's `ThreadStartParams.config` override (`mcp_servers.<name>` TOML-shaped, with
a bearer token supplied via an env var on the spawned `app-server` process, since Codex
has no inline-header field — verified live against codex-cli 0.147.0, see Task 5).

**Tech Stack:** `@modelcontextprotocol/sdk` (already a dependency) for the HTTP MCP
server and `McpServer`/`registerTool`; Node's built-in `node:http`; no new dependencies.

**Spec:** [docs/superpowers/specs/2026-08-21-self-control-tools-design.md](../specs/2026-08-21-self-control-tools-design.md)

## Global Constraints

- No `vscode` import in `src/host/self-control-mcp-server.ts` (matches `message-router.ts`
  — keeps it unit-testable outside the extension host).
- v1 tool surface is `marcode__spawn_session` only — no read-back, no session control.
  Do not add other tools in this plan.
- The server binds to `127.0.0.1` only, never `0.0.0.0`.
- `yarn lint`, `yarn check-types`, `yarn run compile` must pass before every commit.
- Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`, `docs:`); commit after
  every task.

---

## Task 1: `SelfControlMcpServer` — HTTP server, tool registration, handler logic

**Files:**
- Create: `src/host/self-control-mcp-server.ts`
- Test: `src/test/unit/self-control-mcp-server.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (first task). Depends only on a caller-supplied
  `SessionManagerLike` (see below) and `@modelcontextprotocol/sdk`.
- Produces:
  ```ts
  export interface SessionManagerLike {
    catalog(): { id: string; models: { id: string }[]; permissionModes: { id: string }[] }[];
    create(
      providerId: string, cwd: string, model?: string, effort?: undefined,
      mode?: 'default' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypass',
    ): Promise<{ state: { id: string } }>;
  }

  export interface SelfControlMcpConfig {
    /** e.g. `http://127.0.0.1:54231/mcp` */
    url: string;
    /** Random per-launch bearer token. */
    token: string;
  }

  export class SelfControlMcpServer {
    constructor(sessionManager: SessionManagerLike);
    /** Starts the HTTP server, retrying a couple of random ports on EADDRINUSE. */
    start(): Promise<SelfControlMcpConfig>;
    dispose(): Promise<void>;
  }
  ```
  Later tasks import `SelfControlMcpConfig` and pass it to provider constructors.
  `SessionManagerLike` is a narrow structural type — `SessionManager` itself satisfies it
  without any changes to that class, since `catalog()` and `create()` already have this
  shape (see `src/host/session-manager.ts:228` and `:434`).

- [ ] **Step 1: Write the failing test for the tool handler's validation path**

```ts
// src/test/unit/self-control-mcp-server.test.ts
import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { SelfControlMcpServer, type SessionManagerLike } from '../../host/self-control-mcp-server';

function fakeManager(overrides: Partial<SessionManagerLike> = {}): SessionManagerLike {
  return {
    catalog: () => [
      { id: 'claude', models: [{ id: 'sonnet' }], permissionModes: [{ id: 'default' }] },
    ],
    create: async () => ({ state: { id: 's-fake-1' } }),
    ...overrides,
  };
}

suite('SelfControlMcpServer', () => {
  test('start() returns a loopback url and a token', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    assert.strictEqual(config.url.startsWith('http://127.0.0.1:'), true);
    assert.strictEqual(typeof config.token === 'string' && config.token.length > 0, true);
    await server.dispose();
  });

  test('rejects an unknown provider without touching create()', async () => {
    let created = false;
    const server = new SelfControlMcpServer(fakeManager({
      create: async () => { created = true; return { state: { id: 'x' } }; },
    }));
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'marcode__spawn_session', arguments: { provider: 'nope', cwd: '/tmp', prompt: 'hi' } },
      }),
    });
    const body = await res.json() as { result?: { isError?: boolean } };
    assert.strictEqual(body.result?.isError, true);
    assert.strictEqual(created, false);
    await server.dispose();
  });

  test('rejects a request with no/wrong bearer token', async () => {
    const server = new SelfControlMcpServer(fakeManager());
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'marcode__spawn_session', arguments: { provider: 'claude', cwd: '/tmp', prompt: 'hi' } },
      }),
    });
    assert.strictEqual(res.status, 401);
    await server.dispose();
  });

  test('spawn_session calls create() with the requested provider/cwd/prompt and returns a sessionId', async () => {
    let seenArgs: unknown[] = [];
    const server = new SelfControlMcpServer(fakeManager({
      create: async (...args) => { seenArgs = args; return { state: { id: 's-new-1' } }; },
    }));
    const config = await server.start();
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'marcode__spawn_session',
          arguments: { provider: 'claude', model: 'sonnet', mode: 'default', cwd: '/tmp/work', prompt: 'do the thing' },
        },
      }),
    });
    const body = await res.json() as { result: { content: { type: string; text: string }[] } };
    const parsed = JSON.parse(body.result.content[0].text) as { sessionId: string };
    assert.strictEqual(parsed.sessionId, 's-new-1');
    assert.deepStrictEqual(seenArgs.slice(0, 4), ['claude', '/tmp/work', 'sonnet', undefined]);
    await server.dispose();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test:unit --grep "SelfControlMcpServer"`
Expected: FAIL — `Cannot find module '../../host/self-control-mcp-server'`

- [ ] **Step 3: Implement `SelfControlMcpServer`**

```ts
// src/host/self-control-mcp-server.ts
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { PermissionMode } from '../protocol/messages';

/**
 * The slice of `SessionManager` this server needs. Declared structurally, not
 * imported from `session-manager.ts`, so this module carries no `vscode`
 * import in its graph and stays unit-testable with a fake — the same
 * boundary `message-router.ts` keeps for the same reason.
 */
export interface SessionManagerLike {
  catalog(): { id: string; models: { id: string }[]; permissionModes: { id: string }[] }[];
  create(
    providerId: string, cwd: string, model?: string, effort?: undefined, mode?: PermissionMode,
  ): Promise<{ state: { id: string } }>;
}

export interface SelfControlMcpConfig {
  url: string;
  token: string;
}

const PORT_ATTEMPTS = 5;
/** Ephemeral port range; low enough to avoid the small set of IANA-reserved ports. */
const PORT_MIN = 20000;
const PORT_MAX = 60000;

function randomPort(): number {
  return PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));
}

/**
 * One loopback HTTP MCP server, shared by every session this window runs —
 * see the design doc for why one server beats a per-backend mechanism.
 * Exposes exactly one tool, `marcode__spawn_session`. `start()`/`dispose()`
 * bracket its lifetime; `activate()`/`deactivate()` are the only real caller.
 */
export class SelfControlMcpServer {
  private http: Server | undefined;
  private readonly token = randomBytes(24).toString('hex');

  constructor(private readonly sessionManager: SessionManagerLike) {}

  async start(): Promise<SelfControlMcpConfig> {
    const mcp = new McpServer({ name: 'marcode-self-control', version: '1.0.0' });
    mcp.registerTool(
      'marcode__spawn_session',
      {
        title: 'Spawn a new Marcode session',
        description: 'Creates a new agent session in Marcode and sends it an initial prompt. '
          + 'Returns the new session\'s id.',
        inputSchema: {
          provider: z.string().describe('A provider id from this window\'s catalog, e.g. "claude".'),
          model: z.string().optional().describe('A model id the chosen provider offers. Omit for its default.'),
          mode: z.string().optional().describe('A permission mode id the chosen provider offers. Omit for "default".'),
          cwd: z.string().describe('Absolute working directory for the new session.'),
          prompt: z.string().describe('The first message sent to the new session.'),
        },
      },
      async ({ provider, model, mode, cwd, prompt }) => {
        const entry = this.sessionManager.catalog().find((p) => p.id === provider);
        if (!entry) {
          return { isError: true, content: [{ type: 'text', text: `Unknown or unavailable provider: ${provider}` }] };
        }
        if (model !== undefined && !entry.models.some((m) => m.id === model)) {
          return { isError: true, content: [{ type: 'text', text: `Provider ${provider} has no model ${model}` }] };
        }
        const modeId = mode as PermissionMode | undefined;
        if (modeId !== undefined && !entry.permissionModes.some((m) => m.id === modeId)) {
          return { isError: true, content: [{ type: 'text', text: `Provider ${provider} has no mode ${mode}` }] };
        }
        try {
          const session = await this.sessionManager.create(provider, cwd, model, undefined, modeId);
          // `send` is deliberately not part of `SessionManagerLike`: the manager
          // hands back a live session object, and this is the same shape
          // `MessageRouter`'s 'send' case calls — see agent-session.ts's `send`.
          (session as unknown as { send(text: string): void }).send(prompt);
          return { content: [{ type: 'text', text: JSON.stringify({ sessionId: session.state.id }) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
        }
      },
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);

    const http = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${this.token}`) {
        res.writeHead(401).end();
        return;
      }
      void transport.handleRequest(req, res);
    });

    const port = await this.listen(http);
    this.http = http;
    return { url: `http://127.0.0.1:${port}/mcp`, token: this.token };
  }

  private listen(http: Server): Promise<number> {
    return new Promise((resolve, reject) => {
      const attempt = (tries: number): void => {
        const port = randomPort();
        const onError = (err: NodeJS.ErrnoException) => {
          http.removeListener('listening', onListening);
          if (err.code === 'EADDRINUSE' && tries > 1) { attempt(tries - 1); return; }
          reject(err);
        };
        const onListening = () => {
          http.removeListener('error', onError);
          resolve(port);
        };
        http.once('error', onError);
        http.once('listening', onListening);
        http.listen(port, '127.0.0.1');
      };
      attempt(PORT_ATTEMPTS);
    });
  }

  async dispose(): Promise<void> {
    const http = this.http;
    this.http = undefined;
    if (!http) { return; }
    await new Promise<void>((resolve) => { http.close(() => resolve()); });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test:unit --grep "SelfControlMcpServer"`
Expected: PASS (4 tests)

- [ ] **Step 5: `yarn lint` and `yarn check-types`**

Run: `yarn lint && yarn check-types`
Expected: no errors. If `zod` is not already a direct dependency (it is transitive
through `@modelcontextprotocol/sdk` and `@anthropic-ai/claude-agent-sdk`), add it:
`yarn add zod` — check `package.json` first; do not add a duplicate version.

- [ ] **Step 6: Commit**

```bash
git add src/host/self-control-mcp-server.ts src/test/unit/self-control-mcp-server.test.ts package.json yarn.lock
git commit -m "feat: add loopback MCP server exposing marcode__spawn_session"
```

---

## Task 2: Thread the self-control config into `StartOptions`-consuming providers — types only

**Files:**
- Modify: `src/providers/types.ts`

**Interfaces:**
- Consumes: `SelfControlMcpConfig` from Task 1 (`src/host/self-control-mcp-server.ts`).
- Produces: `AgentProvider` implementations (Task 3 for Claude, Task 4 for OpenCode/ACP,
  Task 5 for Codex) each accept this via their own constructor, not via `StartOptions` —
  the config is a property of *how this window reaches its own extension host*, not of
  one session, so it belongs where `ClaudeProvider(loadQueryFn)` and
  `CodexProvider({binPath})` already take their own environment-specific wiring.

No behavior here — this task only adds the shared type both provider constructors will
take, colocated with `StartOptions` since it is conceptually the same kind of thing (a
provider-construction-time input, not a per-session one).

- [ ] **Step 1: Add the type**

```ts
// src/providers/types.ts — near StartOptions
/**
 * The loopback MCP server every session's provider connects to, so an agent
 * running inside it can call `marcode__spawn_session`. Absent when the
 * server failed to bind at startup — see `self-control-mcp-server.ts` — in
 * which case sessions from this provider simply have no such tool.
 */
export interface SelfControlMcpConfig {
  url: string;
  token: string;
}
```

- [ ] **Step 2: `yarn check-types`**

Run: `yarn check-types`
Expected: passes (an unused export is not a type error).

- [ ] **Step 3: Commit**

```bash
git add src/providers/types.ts
git commit -m "feat: add SelfControlMcpConfig type"
```

---

## Task 3: Wire `ClaudeProvider`

**Files:**
- Modify: `src/providers/claude/claude-provider.ts`
- Test: `src/test/unit/claude-provider.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `SelfControlMcpConfig` (Task 2).
- Produces: `ClaudeProvider`'s constructor takes an optional second-shape param; no
  change to its `start()` signature or callers outside this file and `extension.ts`
  (Task 6).

- [ ] **Step 1: Write the failing test**

Find the existing test file's pattern for constructing a `ClaudeProvider` with a fake
`loadQueryFn` (it already exists, since `fetchModels`/`start` are tested there) and add:

```ts
test('start() adds the self-control MCP server to mcpServers when configured', () => {
  let capturedOptions: { mcpServers?: Record<string, unknown> } | undefined;
  const fakeLoadQuery = async () => ((args: { options: { mcpServers?: Record<string, unknown> } }) => {
    capturedOptions = args.options;
    return fakeQuery(); // however the existing suite stubs a Query — reuse it
  });
  const provider = new ClaudeProvider(fakeLoadQuery, { url: 'http://127.0.0.1:1234/mcp', token: 'tok' });
  const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
  run.send('hi', undefined); // or whatever triggers ensureStarted() in the existing suite
  assert.deepStrictEqual(capturedOptions?.mcpServers, {
    marcode_self_control: { type: 'http', url: 'http://127.0.0.1:1234/mcp', headers: { authorization: 'Bearer tok' } },
  });
});

test('start() omits mcpServers when no self-control config was given', () => {
  // same shape, constructed with `new ClaudeProvider(fakeLoadQuery)` (no second arg),
  // and assert `capturedOptions?.mcpServers` is `undefined`.
});
```

Adapt both to however this file already drives `ensureStarted()`/`buildOptions()` in its
existing tests — read the existing suite first and match its `Query`/`Channel` stubbing
exactly rather than inventing a second style.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit --grep "self-control"`
Expected: FAIL — `ClaudeProvider` constructor does not accept a second argument yet
(TypeScript compile error under `tsx`, surfaced as a test failure).

- [ ] **Step 3: Implement**

In `src/providers/claude/claude-provider.ts`:

```ts
constructor(
  private readonly loadQueryFn: () => Promise<QueryFn> = loadQuery,
  private readonly selfControlMcp?: SelfControlMcpConfig,
) {}
```

Add the import: `import type { SelfControlMcpConfig } from '../types';` (alongside the
other `../types` imports already at the top of the file).

In `buildOptions()` (around claude-provider.ts:483, inside the returned `Options`
object), add:

```ts
...(this.selfControlMcp ? {
  mcpServers: {
    marcode_self_control: {
      type: 'http' as const,
      url: this.selfControlMcp.url,
      headers: { authorization: `Bearer ${this.selfControlMcp.token}` },
    },
  },
} : {}),
```

Placed alongside the other conditional spreads already in that object (`effort`,
`allowDangerouslySkipPermissions`), same style.

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test:unit --grep "self-control"`
Expected: PASS

- [ ] **Step 5: Full unit suite + lint + types**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: all pass — this confirms the constructor signature change did not break any
other `ClaudeProvider` construction site (`extension.ts` still calls
`new ClaudeProvider()` with zero args, which remains valid since both params are
optional).

- [ ] **Step 6: Commit**

```bash
git add src/providers/claude/claude-provider.ts src/test/unit/claude-provider.test.ts
git commit -m "feat: wire self-control MCP server into ClaudeProvider"
```

---

## Task 4: Wire `AcpRun`/`OpenCodeProvider`

**Files:**
- Modify: `src/providers/acp/acp-run.ts`
- Modify: `src/providers/opencode/opencode-provider.ts`
- Test: `src/test/unit/acp-run.test.ts` (existing) and
  `src/test/unit/opencode-provider.test.ts` (existing) — add cases.

**Interfaces:**
- Consumes: `SelfControlMcpConfig` (Task 2).
- Produces: `AcpRunOptions` gains `selfControlMcp?: SelfControlMcpConfig`;
  `OpenCodeProvider`'s constructor takes it and passes it through to every `AcpRun` it
  builds.

- [ ] **Step 1: Write the failing test for `AcpRun`**

In `src/test/unit/acp-run.test.ts`, find the existing test that asserts
`newSession`'s params (there is one, since the `mcpServers: []` comment in
`acp-run.ts:261` was written to explain a decision an existing test locks in) and add:

```ts
test('newSession includes the self-control MCP server when configured', async () => {
  // Reuse this file's existing scripted-connection harness — whatever constructs
  // a fake `AcpConnection` for the other newSession-params tests.
  const { run, conn } = harness({ selfControlMcp: { url: 'http://127.0.0.1:9/mcp', token: 't' } });
  await run.start(); // or whatever this suite's existing tests call to trigger newSession
  assert.deepStrictEqual(conn.newSessionParams.mcpServers, [
    { type: 'http', name: 'marcode-self-control', url: 'http://127.0.0.1:9/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] },
  ]);
});
```

Match this file's actual harness/fixture names exactly — read the file first (it already
has at least one `mcpServers`-adjacent assertion per the comment at `acp-run.ts:261`) and
follow its existing pattern for constructing `AcpRunOptions` and a fake `AcpConnection`
rather than the sketch above verbatim.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit --grep "self-control"`
Expected: FAIL — `AcpRunOptions` has no `selfControlMcp` field yet.

- [ ] **Step 3: Implement in `acp-run.ts`**

Add to `AcpRunOptions` (acp-run.ts:34):

```ts
export interface AcpRunOptions {
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  resumeToken?: string;
  tools: ToolMapper;
  modeId(mode: PermissionMode): string | undefined;
  clientName: string;
  /** The loopback MCP server this run's agent should connect to, if any. */
  selfControlMcp?: SelfControlMcpConfig;
}
```

Add the import: `import type { PermissionMode, SelfControlMcpConfig, ... } from '../types';`
(merge into the existing `../types` import at acp-run.ts:4-6).

Add a small helper near the top of the file:

```ts
function mcpServersFor(config: SelfControlMcpConfig | undefined): unknown[] {
  if (!config) { return []; }
  return [{
    type: 'http', name: 'marcode-self-control', url: config.url,
    headers: [{ name: 'Authorization', value: `Bearer ${config.token}` }],
  }];
}
```

Replace both `mcpServers: []` call sites:

```ts
// acp-run.ts:264
const created = await conn.newSession({ cwd: this.opts.cwd, mcpServers: mcpServersFor(this.opts.selfControlMcp) });
```

```ts
// acp-run.ts:320
const rpc = conn.loadSession({ sessionId, cwd: this.opts.cwd, mcpServers: mcpServersFor(this.opts.selfControlMcp) })
```

Update the comment above `acp-run.ts:261` (the one explaining why `mcpServers: []` was
deliberate) — it should now say this is where the self-control server rides, not that
the parameter is intentionally left empty. Keep the rest of its reasoning (the user's own
servers still load from their own config) since that remains true.

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test:unit --grep "self-control"`
Expected: PASS

- [ ] **Step 5: Write the failing test for `OpenCodeProvider`**

In `src/test/unit/opencode-provider.test.ts`, add:

```ts
test('start() passes selfControlMcp through to AcpRun', () => {
  const provider = new OpenCodeProvider({ spawn: fakeSpawn, selfControlMcp: { url: 'http://x/mcp', token: 't' } });
  const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
  // Assert however this suite already inspects the AcpRunOptions an AcpRun was built
  // with — e.g. if AcpRun is constructed directly and mockable, or by inspecting a
  // spy on `new AcpRun`. Follow this file's existing pattern for `start()` assertions.
});
```

- [ ] **Step 6: Run to verify it fails, then implement**

In `src/providers/opencode/opencode-provider.ts`:

```ts
constructor(opts: {
  binPath?: string; spawn?: (bin: string) => AcpChild; selfControlMcp?: SelfControlMcpConfig;
} = {}) {
  this.binPath = opts.binPath;
  this.spawn = opts.spawn ?? ((bin) => spawnOpenCodeAcp(bin));
  this.selfControlMcp = opts.selfControlMcp;
}
```

Add `private readonly selfControlMcp?: SelfControlMcpConfig;` field, add
`SelfControlMcpConfig` to the `../types` import at the top, and in `start()`:

```ts
start(opts: StartOptions): AgentRun {
  const child = this.spawn(this.binPath ?? 'opencode');
  return new AcpRun(child, {
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode,
    resumeToken: opts.resumeToken,
    tools: openCodeTools,
    modeId: openCodeModeId,
    clientName: 'mar-code',
    selfControlMcp: this.selfControlMcp,
  });
}
```

- [ ] **Step 7: Run full suite**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/providers/acp/acp-run.ts src/providers/opencode/opencode-provider.ts \
  src/test/unit/acp-run.test.ts src/test/unit/opencode-provider.test.ts
git commit -m "feat: wire self-control MCP server into ACP sessions (OpenCode)"
```

---

## Task 5: Wire `CodexProvider`

Codex speaks its own app-server JSON-RPC protocol, not generic ACP, and
`ThreadStartParams`/`ThreadResumeParams` have no `mcpServers` field. Verified live
against the installed `codex-cli 0.147.0`:

- `codex mcp add <name> --url <url> --bearer-token-env-var <VAR>` writes
  `[mcp_servers.<name>]` / `url = "..."` / `bearer_token_env_var = "..."` to
  `config.toml` — confirmed by running it against a scratch `CODEX_HOME` and reading the
  file back.
- Both `ThreadStartParams` and `ThreadResumeParams` carry
  `config?: { [key: string]: JsonValue } | null` — a raw config-override map matching the
  same dotted-path shape as the CLI's own `-c key=value` overrides.
- There is no header field for the bearer token — Codex reads it from an environment
  variable named by `bearer_token_env_var`, which must be set on the `app-server`
  process's own environment before it starts.

**Files:**
- Modify: `src/providers/codex/codex-provider.ts`
- Test: `src/test/unit/codex-provider.test.ts` (existing) — add cases.

**Interfaces:**
- Consumes: `SelfControlMcpConfig` (Task 2).
- Produces: `CodexProvider`'s constructor takes it in its existing `opts` object; the
  spawned `app-server` process's env gains `MARCODE_SELF_CONTROL_TOKEN`; every
  `thread/start`/`thread/resume` request carries the `config` override.

- [ ] **Step 1: Write the failing test**

Find this suite's existing test(s) asserting what `thread/start`'s `base` params look
like (there is at least test coverage of `codexSettings(mode)` merging into `base` —
follow that pattern) and add:

```ts
test('thread/start includes an mcp_servers config override when self-control is configured', async () => {
  const requests: { method: string; params: unknown }[] = [];
  const provider = new CodexProvider({
    spawn: fakeSpawnCapturingEnv, // extend or reuse this suite's existing fake spawn
    selfControlMcp: { url: 'http://127.0.0.1:1/mcp', token: 'tok' },
  });
  // Drive exactly however this suite already drives a start() through to its first
  // thread/start request — reuse its existing AppServer/Duplex fixture.
  const run = provider.start({ cwd: '/tmp', permissionMode: 'default' });
  await run.send('hi', undefined);
  const started = requests.find((r) => r.method === 'thread/start');
  assert.deepStrictEqual((started?.params as { config?: unknown }).config, {
    mcp_servers: {
      marcode_self_control: { url: 'http://127.0.0.1:1/mcp', bearer_token_env_var: 'MARCODE_SELF_CONTROL_TOKEN' },
    },
  });
});

test('the spawned app-server process gets MARCODE_SELF_CONTROL_TOKEN in its env', () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const provider = new CodexProvider({
    spawn: (bin) => { /* capture whatever this suite's fake spawn signature exposes for env */ return fakeDuplex(); },
    selfControlMcp: { url: 'http://x/mcp', token: 'tok' },
  });
  provider.start({ cwd: '/tmp', permissionMode: 'default' });
  assert.strictEqual(capturedEnv?.MARCODE_SELF_CONTROL_TOKEN, 'tok');
});
```

Note: this suite's `opts.spawn` fixture type is `(bin: string) => Duplex` today (see
`codex-provider.ts:219`) with no env parameter — Step 3 below changes production
`spawnAppServer` to accept an optional env override, so the *second* test above may need
its fake `spawn` signature widened correspondingly, or (simpler) assert the env via
inspecting `process.env` mutation if that is what the implementation ends up doing. Pick
whichever matches Step 3's actual implementation once written — do not test an
implementation detail the code doesn't have.

- [ ] **Step 2: Run to verify it fails**

Run: `yarn test:unit --grep "self-control"`
Expected: FAIL — `CodexProvider` constructor does not accept `selfControlMcp` yet.

- [ ] **Step 3: Implement**

In `src/providers/codex/codex-provider.ts`:

```ts
constructor(private readonly opts: {
  binPath?: string;
  spawn?: (bin: string, env?: NodeJS.ProcessEnv) => Duplex;
  teardownGraceMs?: number;
  selfControlMcp?: SelfControlMcpConfig;
} = {}) {
  this.binPath = opts.binPath;
  this.teardownGraceMs = opts.teardownGraceMs ?? 5000;
}
```

Add `SelfControlMcpConfig` to the `../types` import.

At the `connect()` call site that spawns the process (`codex-provider.ts:253`,
`child = (this.opts.spawn ?? spawnAppServer)(bin);`), pass an env override:

```ts
const env = this.opts.selfControlMcp
  ? { ...process.env, MARCODE_SELF_CONTROL_TOKEN: this.opts.selfControlMcp.token }
  : undefined;
child = (this.opts.spawn ?? spawnAppServer)(bin, env);
```

Update `spawnAppServer` (`codex-provider.ts:73`) to accept and forward the env:

```ts
export function spawnAppServer(bin: string, env?: NodeJS.ProcessEnv): Duplex {
  const child = spawnChildProcess(bin, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}),
  });
  // ...unchanged below
}
```

In `codex-run.ts`, `startThread()` (around `codex-run.ts:420`), add the config override
to `base`:

```ts
const base = {
  ...settings,
  cwd: this.opts.cwd,
  model: this.model,
  ...(this.opts.selfControlMcp ? {
    config: {
      mcp_servers: {
        marcode_self_control: {
          url: this.opts.selfControlMcp.url,
          bearer_token_env_var: 'MARCODE_SELF_CONTROL_TOKEN',
        },
      },
    },
  } : {}),
};
```

This requires `CodexRunOptions` (wherever `this.opts.cwd`/`this.opts.resumeToken` are
typed in `codex-run.ts` — check the interface near the top of that file, likely named
`CodexRunOptions`) to also carry `selfControlMcp?: SelfControlMcpConfig`, and
`CodexProvider.start()` (`codex-provider.ts:403`) to pass it through the same way it
already passes `cwd`/`model`/`permissionMode`/`resumeToken` into the `CodexRun`/thread
options it builds.

- [ ] **Step 4: Run to verify it passes**

Run: `yarn test:unit --grep "self-control"`
Expected: PASS

- [ ] **Step 5: Full suite**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: all pass — confirms `spawnAppServer`'s widened signature and the `opts.spawn`
fixture type change did not break any other Codex test.

- [ ] **Step 6: Manual verification against the real `codex` binary**

This is the one piece of the plan the unit tests mock rather than prove: whether
`ThreadStartParams.config`'s override actually reaches Codex's `mcp_servers` table the
way `-c key=value` does. Confirm it for real before calling this task done:

1. Build the extension (`yarn run compile`) and launch the extension host (F5, or this
   project's `run` skill if one exists).
2. Create a Codex session (`marcode.enabledProviders` must include `"codex"`).
3. Send it a prompt asking it to call `marcode__spawn_session` (e.g. "call the
   marcode__spawn_session tool to create a new claude session in this same directory
   with the prompt 'hello from codex'").
4. Confirm a new session actually appears in the roster. If the tool is never offered or
   the call fails, capture the raw `thread/start` params and Codex's response (this
   provider's existing debug logging, or a temporary `console.log`) and re-check the
   `config` override shape against a fresh `codex mcp add ... && cat config.toml` probe
   (same technique used to derive Task 5's TOML shape) before changing the code.

- [ ] **Step 7: Commit**

```bash
git add src/providers/codex/codex-provider.ts src/providers/codex/codex-run.ts \
  src/test/unit/codex-provider.test.ts
git commit -m "feat: wire self-control MCP server into Codex threads"
```

---

## Task 6: Wire `extension.ts` — construct, distribute, dispose

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `SelfControlMcpServer` (Task 1), the three providers' new constructor params
  (Tasks 3-5).
- Produces: nothing further downstream — this is the wiring's terminus.

- [ ] **Step 1: Construct the server before the providers, thread its config through**

In `activate()`, `src/extension.ts`, the providers are currently constructed at
lines 178-224 using `manager` — but `manager` needs the providers first, and the
self-control server needs `manager`. Break the cycle the same way `agentsMdNudge`'s
`post` callback does it (extension.ts:317, "assigned below, before this ever runs"):
construct `SelfControlMcpServer` with a `SessionManagerLike`-shaped object that defers to
`manager` via closures, since `manager` is only actually called once the panel is shown
— well after `activate()` returns.

```ts
// After `const manager = new SessionManager(...)` (extension.ts:228-231):
const selfControlServer = new SelfControlMcpServer({
  catalog: () => manager.catalog(),
  create: (providerId, cwd, model, effort, mode) => manager.create(providerId, cwd, model, effort, mode),
});
let selfControlConfig: SelfControlMcpConfig | undefined;
try {
  selfControlConfig = await selfControlServer.start();
} catch (err) {
  // Errors are state, never exceptions, and sessions from this launch simply have no
  // self-control tool — the same posture a failed model probe takes.
  console.warn('[mar-code] self-control MCP server failed to start; spawn_session will be unavailable', err);
}
```

This has to move construction of `providers` to *after* this block (currently
`providers` is built at extension.ts:179-224, before `manager` exists at all) — reorder
so `selfControlServer`/`selfControlConfig` are resolved first, then each provider
constructor receives `selfControlConfig`:

```ts
if (enabled.has('claude')) { providers.set('claude', new ClaudeProvider(undefined, selfControlConfig)); }
const codexProvider = enabled.has('codex')
  ? new CodexProvider({ binPath: codexBinPath(), selfControlMcp: selfControlConfig })
  : undefined;
if (codexProvider) { providers.set('codex', codexProvider); }
const openCodeProvider = enabled.has('opencode')
  ? new OpenCodeProvider({ binPath: openCodeBinPath(), selfControlMcp: selfControlConfig })
  : undefined;
if (openCodeProvider) { providers.set('opencode', openCodeProvider); }
```

Note this genuinely reorders `activate()`: `manager` must exist (for the
`SessionManagerLike` closures) before `selfControlServer.start()` resolves, but
`providers` must exist before `manager` is constructed (its constructor takes
`providers`). Resolve by constructing `manager` with an empty `providers` Map first, then
`.set()`-ing each provider into that same Map afterward — `SessionManager` reads
`this.providers` live on every call (`catalog()`, `create()`, etc. all iterate
`this.providers.values()`/`.get()` at call time, not at construction), so populating the
Map after construction is safe. Confirm this by re-reading `session-manager.ts`'s
constructor (`session-manager.ts:150-181`) — it stores the Map by reference and never
copies it.

Add the import:
```ts
import { SelfControlMcpServer } from './host/self-control-mcp-server';
import type { SelfControlMcpConfig } from './providers/types';
```

- [ ] **Step 2: Dispose on deactivate**

Add to the `context.subscriptions.push(...)` list (alongside the existing
`{ dispose: () => { void manager.dispose(); } }` entry):

```ts
{ dispose: () => { void selfControlServer.dispose(); } },
```

- [ ] **Step 3: `yarn check-types` and `yarn lint`**

Run: `yarn check-types && yarn lint`
Expected: no errors. This is the step that catches any ordering mistake from Step 1 —
a `providers` Map used before declaration, or `manager` referenced before construction,
fails to compile.

- [ ] **Step 4: Manual smoke check**

Run: `yarn run compile` then launch the extension host (F5 in VS Code, or whatever this
project's existing manual-verification step is — check for a `run` skill/task first).
Confirm the panel still opens, a session can still be created and sent a message
normally (the self-control wiring must be invisible to ordinary use), and check the
Debug Console for the `self-control MCP server failed to start` warning — it should NOT
appear on a normal launch.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "feat: start the self-control MCP server at activation"
```

---

## Task 7: End-to-end smoke test — a real tool call actually creates a session

**Files:**
- Test: `src/test/unit/self-control-mcp-server.test.ts` (extend from Task 1)

**Interfaces:**
- Consumes: `SelfControlMcpServer` (Task 1) and a minimal in-memory `SessionManagerLike`
  built directly from a real `SessionManager` wired to a `FakeProvider` — this is the one
  test in the plan that exercises the whole path end to end rather than a narrow slice.

- [ ] **Step 1: Write the test**

```ts
test('a real tool call against a real SessionManager creates a session and delivers the prompt', async () => {
  // Build a real SessionManager with a FakeProvider — follow whatever fixture
  // src/test/unit/session-manager.test.ts already uses for this (TranscriptStore,
  // a fresh temp dir, FakeProvider scripted to answer 'ok').
  const manager = buildRealSessionManagerWithFakeProvider(); // reuse existing test fixture
  const server = new SelfControlMcpServer(manager);
  const config = await server.start();
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'marcode__spawn_session', arguments: { provider: 'fake', cwd: process.cwd(), prompt: 'hello' } },
    }),
  });
  const body = await res.json() as { result: { content: { type: string; text: string }[] } };
  const { sessionId } = JSON.parse(body.result.content[0].text) as { sessionId: string };
  assert.strictEqual(manager.summaries().some((s) => s.id === sessionId), true);
  await server.dispose();
});
```

Read `src/test/unit/session-manager.test.ts` first to find the exact fixture helper (or
inline setup) that constructs a real `SessionManager` + `FakeProvider` pair, and reuse it
rather than hand-rolling a second one.

- [ ] **Step 2: Run to verify it fails, then passes once Task 1's implementation is in
  place**

Run: `yarn test:unit --grep "real SessionManager"`
Expected: PASS (Task 1's implementation already exists by this point — this task is
purely additive coverage, so there is no red step against production code, only against
this new test before it's written correctly).

- [ ] **Step 3: Full suite**

Run: `yarn test:unit && yarn lint && yarn check-types`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/test/unit/self-control-mcp-server.test.ts
git commit -m "test: cover marcode__spawn_session end to end against a real SessionManager"
```

---

## Self-review notes (for the plan author, not a task)

- Spec coverage: mechanism (Task 1, 3-5), components (all tasks), data flow (Task 6),
  error handling (Task 1's 401/validation, Task 6's start-failure catch, Task 5's env
  wiring), testing (every task's test step + Task 7's end-to-end). Deferred items
  (read-back/control tools) are explicitly out of scope and untouched.
- The Codex mechanism (Task 5) is the plan's one genuinely unverified-by-code-reading
  piece beyond the CLI probe already done — flag this to whoever executes Task 5: if
  `ThreadStartParams.config`'s override does not actually reach the `mcp_servers` table
  the way `-c` flags do, the first sign will be `thread/start` succeeding but the agent
  never seeing the tool. Task 5's manual smoke step (mirroring Task 6's) should include
  actually running a Codex session and asking it to call `marcode__spawn_session` before
  considering the task done, not just the unit-test mock.

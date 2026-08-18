// Opt-in tests that put relocation in front of a real agent.
//
// Everything else in this feature is measured against a `FakeProvider`: the
// offer is raised, the move happens, the seed is built, and every assertion is
// about *shape*. None of them can tell whether a replayed transcript actually
// reconstitutes a conversation — a seed that is well-formed and useless passes
// all of them. This suite is the only place that asks the agent itself.
//
// The second test answers the spec's open question. `ThreadScope` says
// declaring `'global'` when the truth is `'cwd'` costs correctness — the
// resume silently finds nothing and the agent comes up blank behind a full
// transcript — so the claim has to be measured rather than reasoned about.
// Measured here, and turned into a guard: the test fails if `threadScope`
// disagrees with what the real binary just did.
//
// Gated exactly like `codex-smoke.test.ts` (same `./codex-gate` module): a
// contributor without codex, or with codex but signed out, gets a skip and a
// green suite — never a failure.

import * as assert from 'assert';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AgentSession } from '../../host/agent-session';
import { SessionManager } from '../../host/session-manager';
import { TranscriptStore } from '../../host/transcript-store';
import { codexAvailable, collectUntilTurnEnd, probeAuth } from './codex-gate';
import type { HostToWebview, TranscriptItem } from '../../protocol/messages';
import { CodexProvider } from '../../providers/codex/codex-provider';
import type { AgentProvider } from '../../providers/types';

const run = promisify(execFile);

/** The thing the agent is told about, and the thing it has to remember. */
const SUBJECT = 'the SUNFLOWER file-format parser';
const CODEWORD = 'SUNFLOWER-7788';

const roots: string[] = [];
const managers: SessionManager[] = [];

/** See the bring-back suite: `realpath` matters on Windows, where tmpdir is short. */
async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'mar-reloc-smoke-')));
  roots.push(dir);
  return dir;
}

async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir], { windowsHide: true });
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'user.name', 'Test'], { cwd: dir, windowsHide: true });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, windowsHide: true });
  await fs.writeFile(join(dir, 'README.md'), 'seed\n');
  await run('git', ['add', 'README.md'], { cwd: dir, windowsHide: true });
  await run('git', ['commit', '-m', 'seed'], { cwd: dir, windowsHide: true });
}

/** Waits for the turn `send()` just started to finish. Never throws on timeout. */
async function settle(session: AgentSession, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (session.state.status === 'idle' || session.state.status === 'error') { return; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Everything the agent has said in this session, oldest first. */
async function assistantText(store: TranscriptStore, id: string): Promise<string> {
  const { items } = await store.tail(id, 500);
  return items.flatMap((i) => (i.role === 'assistant' ? [i.text] : [])).join('\n');
}

suite('relocation smoke (opt-in)', function () {
  // Real turns against a real model: minutes, not seconds.
  this.timeout(300_000);

  suiteSetup(async function () {
    if (!codexAvailable()) {
      console.log('[relocation smoke] skipping: no codex binary on PATH');
      this.skip();
      return;
    }
    const probe = await probeAuth();
    if (!probe.signedIn) {
      console.log(`[relocation smoke] skipping: ${probe.reason}`);
      this.skip();
    }
  });

  teardown(async () => {
    while (managers.length > 0) { await managers.pop()!.dispose(); }
    while (roots.length > 0) {
      await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  test('a session that moves into a worktree remembers what it was doing', async function () {
    const container = await tempDir();
    const repo = join(container, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await initRepo(repo);
    const tree = resolve(join(container, 'trees', 'feat-sunflower'));
    await run('git', ['worktree', 'add', tree, '-b', 'feat-sunflower'], { cwd: repo, windowsHide: true });

    const store = new TranscriptStore(await tempDir());
    const provider = new CodexProvider({});
    const emitted: HostToWebview[] = [];
    const manager = new SessionManager(store, new Map<string, AgentProvider>([['codex', provider]]), (m) => emitted.push(m));
    managers.push(manager);
    await manager.init();
    // `create` refuses a provider with no models, and Codex's list only
    // exists once it has been asked for.
    await manager.refreshModels(repo);

    // Plan mode is approvalPolicy 'never' + sandbox 'read-only'
    // (map-settings.ts): this agent cannot write to the tree it runs in.
    const session = await manager.create('codex', repo, undefined, undefined, 'plan');
    const id = session.state.id;
    session.send(
      `We are working on ${SUBJECT}. It reads .sun files. Do not do anything yet — reply with just "ok".`,
    );
    await settle(session, 120_000);
    assert.strictEqual(
      (await assistantText(store, id)).length > 0,
      true,
      'the first turn produced no assistant text — the smoke test cannot measure a replay of nothing',
    );

    // The offer the way `AgentSession.offerRelocation` writes one. Injected
    // rather than provoked: making a real agent run `git worktree add` would
    // measure the agent's obedience, not the replay this test is about.
    const offer: TranscriptItem = {
      id: 'rel-smoke-1', ts: Date.now(), role: 'relocation', path: tree, state: 'pending',
    };
    store.append(id, offer);
    await store.flush(id);

    await manager.relocate(id, offer.id, true);
    const moved = manager.get(id)!;
    assert.strictEqual(moved.state.cwd, tree);
    // Which mechanism carries the conversation is the provider's declared
    // scope, not this test's assumption. Under 'cwd' the new tree has no
    // thread, so the move must have built a seed; under 'global' the thread
    // travels and a seed would be waste. Asserting the mechanism *against the
    // declaration* keeps this honest either way — what the test actually
    // measures is the outcome below: the agent still knows the subject.
    const scope = provider.threadScope;
    if (scope === 'cwd') {
      assert.strictEqual(
        moved.pendingSeedText !== undefined && moved.pendingSeedText.includes('SUNFLOWER'),
        true,
        "threadScope is 'cwd', so the move should have built a replay — it did not",
      );
    } else {
      assert.strictEqual(
        moved.pendingSeedText,
        undefined,
        "threadScope is 'global', so the thread resumes and no replay should be built",
      );
    }

    moved.send('In one short sentence: what were we working on? Name it exactly.');
    await settle(moved, 120_000);

    const said = await assistantText(store, id);
    const answer = said.slice(said.indexOf('ok') + 1);
    console.log(`[relocation smoke] the agent, asked in the new tree: ${answer.trim().slice(0, 400)}`);
    assert.strictEqual(
      /sunflower/i.test(answer),
      true,
      `a replayed conversation did not carry the subject across the move. The agent said: ${answer}`,
    );
  });

  test('a codex thread resumed from another directory: does the conversation survive?', async function () {
    const dirA = await tempDir();
    const dirB = await tempDir();
    // No provider-level teardown: `CodexProvider` owns no process of its own
    // — each `start()` spawns its own app-server, and both runs below are
    // disposed in their own `finally`.
    const provider = new CodexProvider({});
    await provider.fetchModels(dirA);

    const first = provider.start({ cwd: dirA, permissionMode: 'plan' });
    let token: string | undefined;
    try {
      first.send(`Remember this codeword: ${CODEWORD}. Reply with just "ok".`);
      const events = await collectUntilTurnEnd(first, 120_000);
      token = events.flatMap((e) => (e.kind === 'session' ? [e.resumeToken] : [])).at(-1);
    } finally {
      await first.dispose();
    }
    assert.strictEqual(
      typeof token === 'string' && token.length > 0,
      true,
      'the first turn reported no resume token — there is nothing to resume from',
    );

    // The control, and it is not optional: a resume that answers nothing from
    // *any* directory would make the cross-directory result meaningless — it
    // would be measuring our own resume path failing, not codex's thread
    // scope. Ask in the directory the thread was born in first.
    const control = provider.start({ cwd: dirA, permissionMode: 'plan', resumeToken: token });
    let controlReply = '';
    try {
      control.send('What codeword did I ask you to remember? Reply with the codeword and nothing else.');
      const events = await collectUntilTurnEnd(control, 60_000);
      controlReply = events.flatMap((e) => (e.kind === 'text' ? [e.delta] : [])).join('');
    } finally {
      await control.dispose();
    }
    if (!controlReply.includes(CODEWORD)) {
      // An environment answer, not a product one — skipped rather than
      // failed, exactly like the gate above.
      console.log(
        '[relocation smoke] skipping the cross-directory measurement: resuming in the SAME '
        + `directory did not carry the codeword either (reply: ${controlReply.trim().slice(0, 200) || '(nothing)'})`,
      );
      this.skip();
      return;
    }

    const second = provider.start({ cwd: dirB, permissionMode: 'plan', resumeToken: token });
    let reply = '';
    let outcome = 'no turn-end within the deadline';
    try {
      second.send('What codeword did I ask you to remember? Reply with the codeword and nothing else.');
      const events = await collectUntilTurnEnd(second, 60_000);
      reply = events.flatMap((e) => (e.kind === 'text' ? [e.delta] : [])).join('');
      // What the run actually did matters as much as what it said. A resume
      // that errors and a resume that answers blankly are both "did not
      // survive", but only one of them is a bug worth chasing later.
      const end = events.find((e) => e.kind === 'turn-end');
      if (end?.kind === 'turn-end') { outcome = `turn-end ${end.reason}${end.error ? `: ${end.error}` : ''}`; }
      outcome += ` [events: ${events.map((e) => e.kind).join(', ') || 'none'}]`;
    } finally {
      await second.dispose();
    }

    const survived = reply.includes(CODEWORD);
    console.log(
      `[relocation smoke] same-directory resume worked; resumed ${token!.slice(0, 12)}… `
      + 'from a DIFFERENT directory: '
      + `conversation ${survived ? 'SURVIVED' : 'did NOT survive'} — ${outcome}. `
      + `Reply: ${reply.trim().slice(0, 200) || '(nothing)'}`,
    );

    // The measurement, kept as a guard rather than a log. `'global'` is a
    // claim that a token resolves anywhere; this is the only thing that can
    // check it, and a CLI upgrade that changes the answer should fail here
    // rather than silently start losing conversations in a user's panel.
    assert.strictEqual(
      provider.threadScope === 'global',
      survived,
      survived
        ? 'a codex thread DID resume across directories — CodexProvider.threadScope should be \'global\''
        : 'a codex thread did NOT resume across directories — CodexProvider.threadScope must stay \'cwd\'',
    );
  });
});

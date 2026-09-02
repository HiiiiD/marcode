// See map-events.ts for the full record of the SDK surface read from
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts. Notes specific to
// this file:
//
// - `@anthropic-ai/claude-agent-sdk` ships `"type": "module"` (ESM-only,
//   `main: "sdk.mjs"`). This extension host bundle is CJS (esbuild
//   `format: 'cjs'`), so the runtime `query` function must be reached via a
//   dynamic `import()` — a static `import { query } from '...'` fails
//   TypeScript compilation with TS1479 ("referenced file is an ECMAScript
//   module and cannot be imported with 'require'"). Types are imported
//   separately with `import type ... with { 'resolution-mode': 'import' }`,
//   which resolves the `.d.ts` without requiring a CJS/ESM interop shim.
// - `canUseTool`'s real signature is `(toolName, input, options) => Promise<
//   PermissionResult | null>`, where `options.toolUseID` is the id — not the
//   single-object `(request: { tool_name, name, input }) => ...` shape the
//   plan's pseudocode assumed. Fixed here.
//
// LAZY START (this round): `start()` used to call `query()` immediately —
// i.e. inside the `AgentSession` constructor, before any message exists —
// which spawns a `claude` CLI subprocess for every session the moment it is
// created, whether or not the user ever sends anything (flagged by an
// earlier review as "opening N sessions spawns N idle CLI processes"). The
// query is now constructed lazily, on the first `send()`, via `ensureStarted()`.
// This has a second, load-bearing consequence: `Options` — in particular
// `permissionMode` and the conditional `allowDangerouslySkipPermissions`
// (see below) — are built from `pendingMode`/`pendingEffort`, mutable local
// state that `setPermissionMode`/`setEffort` update directly whenever the
// query has not been constructed yet, rather than from the `StartOptions`
// snapshot `start()` was originally called with. A `setPermissionMode('bypass')`
// call before the first `send()` is therefore simply what the session
// starts with, flag included — no restart, no dispose-and-respawn hack, no
// guard on transcript items needed anywhere in this file or in
// `AgentSession`. `PERMISSION_MODE` remains the only place a `PermissionMode`
// is translated to the SDK's spelling.
//
// After the query is constructed (`queryRef` is set), `setPermissionMode`
// and `setEffort` switch to the live seams described below
// (`Query.setPermissionMode` / `Query.applyFlagSettings`) instead of
// mutating the now-irrelevant pending values.
//
// - `setEffort` uses `Query.applyFlagSettings({ effortLevel })`, a genuine
//   live setter (see map-events.ts header for why this is stronger than the
//   plan's "store and apply on next send" fallback). If it fails (e.g. the
//   session isn't in streaming mode), the failure is swallowed rather than
//   surfaced as a turn-end error — a rejected effort change is not a failed
//   agent turn, and AgentSession.setEffort() only awaits nothing (setEffort
//   is fire-and-forget by interface), so there is no caller to report to.
// - `setPermissionMode` uses `Query.setPermissionMode(mode)` (sdk.d.ts:2377,
//   "Only available in streaming input mode" — which is the mode this
//   provider always uses), so a mode switch mutates the *running* session,
//   not just recorded UI state. `Query.setPermissionMode` returns
//   `Promise<void>`, and the `AgentRun`/`Query` methods it's built on are
//   themselves capable of throwing synchronously before ever returning a
//   promise (e.g. if the underlying transport is already torn down) — both
//   `setEffort` and `setPermissionMode` wrap the call in `try/catch` *and*
//   attach a `.catch()` to the returned promise, so neither a synchronous
//   throw nor an async rejection can escape a `void`-returning `AgentRun`
//   method.
// - `allowDangerouslySkipPermissions` must be `true` exactly when, and only
//   when, the *effective mode at construction time* is 'bypass' — strict
//   equality, key absent (not `false`) for every other mode. This was
//   briefly set unconditionally in an earlier pass; that reasoning ("the
//   human has explicitly opted into bypass for every session") did not
//   come from the human — it was an inference in the instruction that
//   produced it, and the human decided against it on review. The accurate,
//   verifiable statement is narrower: bypass is an opt-in capability
//   granted per session at construction, because the SDK reads this flag
//   only once, when `query()` is constructed
//   (`Options.allowDangerouslySkipPermissions`) — unlike `permissionMode`
//   itself, which has a live setter. Because construction is now lazy (see
//   above), "at construction time" means "at first `send()`", not "when
//   `start()` was called" — so a mode chosen any time before the first
//   message is still exactly what the session starts with.
// - `Options.stderr` is deliberately left unset — forwarding raw CLI stderr
//   into a `console.error` (as the plan's pseudocode did) risks leaking
//   secrets. CORRECTION to an earlier pass of this comment: leaving the
//   option unset does NOT keep stderr out of the picture. The installed
//   SDK's `ProcessTransport` accumulates a `stderrTail` unconditionally (not
//   gated on `Options.stderr`) and appends `. stderr: <tail>` to the `Error`
//   it throws on a nonzero exit or signal kill — which reaches the query
//   pump's catch below regardless of whether we ever set the callback. The
//   SDK pre-redacts a fixed table of well-known token shapes before
//   capturing that tail, but anything outside the table passes through
//   verbatim. See redact.ts for the mitigation: every message built by
//   `errorMessage()` below is run through `redactSecrets()` before it
//   becomes an `AgentEvent` (and therefore before it can reach a persisted
//   transcript item).
// - `Options.includePartialMessages` is left unset (defaults to false/off).
//   Enabling it emits fine-grained `SDKPartialAssistantMessage` stream
//   events (`type: 'stream_event'`) requiring a much wider set of shapes to
//   map for no functional gain here: full `assistant` messages already
//   arrive per content block, which is enough for `AgentSession` to render
//   incremental text/thinking/tool-start items.
//
// The two live setters below (`setEffort`, `setPermissionMode`) swallow their
// failures: a rejected effort or mode change is not a failed agent turn, so it
// is not surfaced to the user as one. Swallowing silently, though, once cost a
// full debugging round — a live report of "changing effort does nothing" was
// indistinguishable from the outside between "the call was never made", "the
// call was made and rejected", and "the call resolved but had no effect". The
// failure paths therefore log; the success paths do not, so normal operation
// stays quiet. That root cause turned out to be in the webview reducer, not
// here: both SDK calls resolve.
//
// OPEN QUESTION, not acted on here: the installed `.d.ts` shows
// `Settings.permissions.defaultMode` accepting `'bypassPermissions'`,
// `Query.applyFlagSettings` taking arbitrary `Settings` keys, and a
// `permissions.disableBypassPermissionsMode` opt-out — suggesting bypass may be
// reachable live, via `applyFlagSettings`, without ever touching
// `Options.allowDangerouslySkipPermissions`. Unverified. The lazy-start design
// in this file is correct either way, but it may mean the "only at
// construction" constraint documented here is narrower than the SDK requires.
import type {
  CanUseTool, Options,
  Query,
  EffortLevel as SdkEffortLevel,
  PermissionMode as SdkPermissionMode,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages' with { 'resolution-mode': 'import' };
import { findModel, resolveEffort } from '../../shared/model-catalog';
import { attachmentLines, imageAttachments, readBase64 } from '../attachment-payload';
import { formatEditorContext } from '../format-editor-context';
import type {
  AgentEvent, AgentProvider, AgentRun, Attachment,
  ContextBreakdown,
  EditorContext,
  EffortLevel, Invocable, ModelInfo, PermissionMode, PermissionModeInfo,
  QuestionAnswers, SelfControlMcpConfig, StartOptions, ThreadScope, ToolDecision, UsageWindow,
} from '../types';
import { toInvocables } from './map-commands';
import { toContextBreakdown, toUsageWindows, type ContextUsageLike, type UsageResponseLike } from './map-context';
import { mapEvent } from './map-events';
import { toPermissionMeta, toQuestionSpecs, toSdkAnswers } from './map-questions';
import { toToolCall } from './map-tools';
import { redactSecrets } from './redact';

/**
 * The SDK's own failure text, turned into something a panel can show.
 *
 * This message is the provider's unavailability reason: it travels to the
 * webview and is read by someone deciding what to install, not by someone
 * debugging our SDK options. So the missing-binary case — the overwhelmingly
 * common one, since the SDK ships no CLI of its own — names Claude Code
 * rather than `options.pathToClaudeCodeExecutable`. Everything else is passed
 * through redacted; an unrecognized failure said plainly beats a guess.
 */
function unavailableReason(err: unknown): string {
  const raw = errorMessage(err);
  if (/executable not found|ENOENT/i.test(raw)) { return 'Claude Code CLI not found.'; }
  return authFailureReason(raw) ?? raw;
}

/**
 * The SDK's own OAuth-expiry text, turned into the same "not signed in"
 * phrasing Codex's `fetchModels` already uses — so the panel's reauth
 * action (matched client-side on that phrasing) recognizes both providers
 * with one pattern. `undefined` when `raw` is not an auth failure, so
 * callers fall back to the message unchanged.
 */
function authFailureReason(raw: string): string | undefined {
  return /Failed to authenticate|OAuth session expired/i.test(raw)
    ? 'Not signed in to Claude. Run `claude auth login`.'
    : undefined;
}

/** The subset of the SDK's `ModelInfo` this adapter reads. */
type SdkModelInfo = {
  value: string;
  displayName: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
};

/**
 * The SDK reports which effort levels a model accepts but not which one it
 * defaults to, so pick 'high' when it is on offer (the CLI's own default) and
 * otherwise the deepest level the model has.
 */
function toModelInfo(m: SdkModelInfo): ModelInfo {
  const levels = m.supportedEffortLevels ?? [];
  const effort = m.supportsEffort && levels.length > 0
    ? { levels, default: levels.includes('high') ? 'high' as const : levels[levels.length - 1] }
    : undefined;
  return {
    id: m.value, displayName: m.displayName,
    ...(m.resolvedModel !== undefined && m.resolvedModel !== m.value
      ? { resolvedModel: m.resolvedModel }
      : {}),
    effort,
  };
}

/**
 * Ours -> the SDK's real `PermissionMode` union (verified against the
 * installed .d.ts — see map-events.ts). Every one of our members has a real
 * counterpart; only 'bypass' needs renaming.
 */
const PERMISSION_MODE: Record<PermissionMode, SdkPermissionMode> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  dontAsk: 'dontAsk',
  bypass: 'bypassPermissions',
};

/** The shape of the SDK's `query()` export, isolated so tests can inject a fake. */
type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/**
 * Real, dynamic-import-backed query loader — the production default. Kept
 * as its own function (rather than inlined into `start()`) so a test can
 * construct `new ClaudeProvider(fakeLoadQuery)` and observe exactly when,
 * and with what `Options`, a query gets constructed, without contorting the
 * lazy-start logic itself or reaching into a real CLI subprocess.
 */
async function loadQuery(): Promise<QueryFn> {
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  return mod.query;
}

class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((v: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) { return; }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const next = this.queue.shift();
        if (next !== undefined) { return Promise.resolve({ value: next, done: false }); }
        if (this.closed) { return Promise.resolve({ value: undefined as never, done: true }); }
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}

/** Sentinel: a parked question settled by cancellation, not by an answer. */
const CANCELLED: QuestionAnswers = Object.freeze({ __cancelled__: [] }) as QuestionAnswers;

export class ClaudeProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly threadScope: ThreadScope = 'cwd';
  readonly loginKind?: 'oauth' | 'none';

  /**
   * The last answer from `fetchModels()`, and the whole of what this provider
   * knows. Empty until a probe succeeds: there is no hardcoded catalog to
   * fall back to, because a list of models is also a claim that this install
   * can run them — and the SDK ships no CLI, so on a machine without Claude
   * Code that claim is false. A provider with no models is not selectable at
   * all; see SessionManager.catalog().
   */
  private models: ModelInfo[] = [];

  /** Instance env override, merged into every `Options.env` this provider builds. */
  private readonly env?: NodeJS.ProcessEnv;
  /** Instance binary override — a second Claude Code install, not just a second account. */
  private readonly pathToClaudeCodeExecutable?: string;

  constructor(
    private readonly loadQueryFn: () => Promise<QueryFn> = loadQuery,
    private readonly selfControlMcp?: SelfControlMcpConfig,
    instance?: {
      id?: string;
      displayName?: string;
      env?: NodeJS.ProcessEnv;
      pathToClaudeCodeExecutable?: string;
      loginKind?: 'oauth' | 'none';
    },
  ) {
    this.id = instance?.id ?? 'claude';
    this.displayName = instance?.displayName ?? 'Claude';
    this.env = instance?.env;
    this.pathToClaudeCodeExecutable = instance?.pathToClaudeCodeExecutable;
    this.loginKind = instance?.loginKind;
  }

  listModels(): ModelInfo[] { return this.models; }

  /**
   * The CLI's own model catalog, from the same session-free probe the
   * invocables list uses. What a given install can run is decided by its
   * provider, its settings cascade and any enterprise `availableModels`
   * policy — none of which this extension can know statically.
   *
   * This is also the availability probe: a rejection clears the catalog, so a
   * binary that stops working (uninstalled, or a configured path pointed
   * somewhere wrong) takes the provider out of the picker on the next refresh
   * instead of leaving it selectable against models it can no longer run.
   *
   * Rejections propagate — the caller decides the retry policy — but carry
   * `unavailableReason`'s text, because that message is what the panel shows.
   */
  async fetchModels(cwd: string): Promise<ModelInfo[]> {
    let models: SdkModelInfo[];
    try {
      models = await this.probe(cwd, (q) => q.supportedModels());
    } catch (err) {
      this.models = [];
      throw new Error(unavailableReason(err));
    }
    this.models = models.map(toModelInfo);
    return this.models;
  }

  /**
   * The cwd's catalog, with no session. Nothing is ever sent, so there is no
   * turn, no tokens and no agent work — only the CLI's init handshake.
   *
   * This exists because the session's own query is constructed lazily on the
   * first send() (only construction can set `bypass`), and the menu has to
   * work before that first message — creating a session in order to run a
   * slash command is the primary case, not an edge one.
   *
   * Rejections propagate: CatalogService decides the retry policy, and
   * swallowing here would hide a permanently broken CLI behind an empty menu.
   */
  async listInvocables(cwd: string): Promise<Invocable[]> {
    return toInvocables(await this.probe(cwd, (q) => q.supportedCommands()));
  }

  /**
   * Account plan usage for a working directory, with NO session required —
   * this is what lets the strip show real numbers at activation, before any
   * session exists and before anything is sent.
   *
   * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` is the
   * `get_usage` control request (sdk.d.ts:2521). The name is what it is;
   * this is the only place in the codebase that spells it, and it is what
   * Anthropic's own VS Code extension calls for the same data. The response
   * is read through `UsageResponseLike`, so a renamed or added field
   * degrades to "no windows" instead of throwing.
   *
   * Rejections propagate: SessionManager decides retry policy, and
   * swallowing here would hide a permanently broken CLI behind an empty
   * strip that looks exactly like "you have no plan limits".
   */
  async fetchUsage(cwd: string): Promise<UsageWindow[] | undefined> {
    return toUsageWindows(await this.probe(
      cwd,
      (q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
    ) as UsageResponseLike);
  }

  /**
   * Runs one control request against a throwaway query over a prompt stream
   * that never yields, and closes it. Shared by every session-free lookup:
   * each one is a CLI subprocess, and the close must not depend on the
   * request succeeding.
   */
  private async probe<T>(cwd: string, ask: (query: Query) => Promise<T>): Promise<T> {
    const query = await this.loadQueryFn();
    // A channel that is closed immediately: the query needs an async iterable
    // for `prompt`, and this one ends without ever yielding a message.
    const prompts = new Channel<SDKUserMessage>();
    prompts.close();
    const probe = query({
      prompt: prompts,
      options: {
        cwd,
        ...(this.env ? { env: this.env } : {}),
        ...(this.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable } : {}),
      },
    });
    try {
      return await ask(probe);
    } finally {
      // finally, not a success-path close: a failed control request must not
      // leak a CLI subprocess for the life of the window.
      try {
        probe.close();
      } catch {
        // Best-effort: the probe is being discarded regardless.
      }
    }
  }

  /**
   * All six. The union was drawn from Claude's own mode set, so this provider
   * is the one case where declaring a subset would be declaring nothing.
   */
  listPermissionModes(): PermissionModeInfo[] {
    return [
      { id: 'default' }, { id: 'acceptEdits' }, { id: 'auto' },
      { id: 'plan' }, { id: 'dontAsk' }, { id: 'bypass' },
    ];
  }

  start(opts: StartOptions): AgentRun {
    const events = new Channel<AgentEvent>();
    const prompts = new Channel<SDKUserMessage>();
    type Parked =
      | { kind: 'permission'; resolve: (decision: ToolDecision) => void }
      | { kind: 'question'; input: Record<string, unknown>; resolve: (answers: QuestionAnswers) => void };
    const parked = new Map<string, Parked>();
    /**
     * Settles a parked entry as cancelled. Deletes before resolving, so an
     * abort and an explicit interrupt cannot double-resolve or double-report.
     *
     * A question resolves `deny` and never `null`: the SDK reserves null for
     * "control_response already sent out-of-band", and an accidental null
     * leaves the tool blocked with no park deadline (sdk.d.ts:196-204).
     */
    const cancelParked = (id: string) => {
      const entry = parked.get(id);
      if (!entry) { return; }
      parked.delete(id);
      events.push({ kind: 'request-cancelled', id });
      if (entry.kind === 'permission') { entry.resolve({ allow: false, reason: 'Turn cancelled' }); }
      else { entry.resolve(CANCELLED); }
    };
    let disposed = false;
    let started = false;
    let queryRef: Query | undefined;
    // Effective mode/effort for a query not yet constructed. Read by
    // ensureStarted() -> buildOptions() at the moment the query actually
    // gets built (first send()); mutated directly by setPermissionMode()/
    // setEffort() below whenever that hasn't happened yet.
    let pendingMode: PermissionMode = opts.permissionMode;
    let pendingEffort = opts.effort;
    // Same closure-var treatment as pendingMode/pendingEffort above, and the
    // same two-sided story: `Options.model` is read only at construction, so a
    // change before the first send() is picked up by buildOptions() below,
    // while a change after it goes over `Query.setModel` — a real control-channel
    // seam, not a recording. Both paths take effect, which is why the model
    // control stays enabled for the life of the session.
    let pendingModel = opts.model;
    let pump: Promise<void> = Promise.resolve();
    // Resolves once ensureStarted()'s construction settles (queryRef assigned,
    // or construction failed) — NOT when the whole turn finishes. This is
    // what lets usageWindows() below, called right after the send() that
    // triggers construction, await the *same* in-flight query rather than
    // reading queryRef synchronously (a real race: the query isn't assigned
    // until a microtask after send() returns) or starting a second one.
    let resolveQueryReady: ((query: Query | undefined) => void) | undefined;
    const queryReady = new Promise<Query | undefined>((resolve) => { resolveQueryReady = resolve; });
    // The live set of task ids the CLI has detached from the foreground turn
    // (Ctrl+B semantics) — REPLACEd wholesale on every `background-tasks-changed`
    // event, mirroring the SDK's own level-signal contract. `interrupt()`
    // below stops each of these explicitly: `Query.interrupt()` only cancels
    // the foreground turn, and a backgrounded task survives it by design.
    let backgroundTaskIds: string[] = [];
    // Bumped on every send() — the ordinal of the turn currently in flight.
    // Needed because `session` (the `for await` loop below) is ONE persistent
    // loop for the whole conversation, not one per turn: `interrupt()` pushes
    // a synthetic `turn-end` the moment the SDK accepts the request, but the
    // SDK's own `result` message for that same interrupted turn can still
    // arrive later, over that same loop. If a queued message was drained and
    // delivered in between, a newer turn is already running by the time that
    // late message shows up, and mapping it to a second `turn-end` would
    // wrongly end the newer turn instead of the one it actually belongs to.
    // See `interrupt()` and the `for await` loop below.
    let turnGen = 0;
    // The turn generation `interrupt()` last self-resolved, so the loop below
    // can recognize a late genuine echo of that same turn-end and drop it
    // once `turnGen` has moved on. `undefined` once consumed or once a fresh
    // interrupt has not happened for the current turn.
    let interruptedGen: number | undefined;

    const canUseTool: CanUseTool = async (toolName, input, options) => {
      const id = options.toolUseID;
      // Before the listener, not after: `addEventListener('abort')` on a
      // signal that has ALREADY aborted never fires, so a request that raced
      // the abort would park a promise nothing can ever resolve — the turn is
      // gone, and neither `interrupt()` nor a click can reach an entry that
      // was added after they ran. Deny immediately instead, with the same
      // message `cancelParked` resolves with.
      if (options.signal.aborted) { return { behavior: 'deny', message: 'Turn cancelled' }; }
      options.signal.addEventListener('abort', () => { cancelParked(id); }, { once: true });
      const specs = toolName === 'AskUserQuestion' ? toQuestionSpecs(input) : undefined;
      if (specs) {
        events.push({ kind: 'question', id, questions: specs, blocking: true });
        const answers = await new Promise<QuestionAnswers>((resolve) => {
          parked.set(id, { kind: 'question', input, resolve });
        });
        if (answers === CANCELLED) { return { behavior: 'deny', message: 'Turn cancelled' }; }
        return { behavior: 'allow', updatedInput: { ...input, answers: toSdkAnswers(answers) } };
      }
      const meta = toPermissionMeta(options);
      events.push({ kind: 'permission', id, tool: toToolCall(toolName, input), ...(meta ? { meta } : {}) });
      const decision = await new Promise<ToolDecision>((resolve) => {
        parked.set(id, { kind: 'permission', resolve });
      });
      return decision.allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: decision.reason ?? 'Denied by user' };
    };

    const buildOptions = (): Options => {
      const isBypassMode = pendingMode === 'bypass';
      // Effort is reconciled here as well as in the host (AgentSession.setModel)
      // because this is where it actually reaches the CLI: a session persisted
      // before a catalog change can be resumed carrying an effort its model no
      // longer takes, and that value never passes through a setter on the way
      // in. An id the catalog does not list keeps whatever it was given — the
      // CLI is the authority on models this build has never heard of.
      const effort = resolveEffort(findModel(this.listModels(), pendingModel), pendingEffort);
      // The SDK's own `EffortLevel` (sdk.d.ts) predates 'ultra' and has no
      // reason to grow it, so the cast below bridges our now-wider shared
      // union to the SDK's narrower one. It is safe when `resolveEffort`
      // found a row for `pendingModel` above: no Claude model's
      // `effort.levels` ever lists 'ultra' (see providers/types.ts), so a
      // known row clamps it away same as any other unsupported value. It is
      // NOT independently safe for the "catalog does not list this id" branch
      // documented above, which passes `pendingEffort` through unchanged —
      // that gap is pre-existing (not introduced by this cast) and is the
      // documented tradeoff of letting a session the catalog has never seen
      // resume with whatever effort it was given.
      return {
        cwd: opts.cwd,
        model: pendingModel,
        resume: opts.resumeToken,
        permissionMode: PERMISSION_MODE[pendingMode],
        canUseTool,
        // Adaptive is already the default for every model that supports it,
        // so the type is not what this is for — `display` is. Left unset, the
        // CLI emits a `thinking` content block per reasoning turn whose
        // `thinking` string is empty, and the panel has no way to tell that
        // apart from a model that did not reason at all. Probed against the
        // real SDK: bare options give `thinking: ""`, this gives the summary.
        // Safe on models without adaptive thinking — verified on Haiku, which
        // takes the same option and returns a summary.
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(this.env ? { env: this.env } : {}),
        ...(this.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable } : {}),
        ...(effort !== undefined ? { effort: effort as SdkEffortLevel } : {}),
        ...(isBypassMode ? { allowDangerouslySkipPermissions: true } : {}),
        ...(this.selfControlMcp ? {
          mcpServers: {
            marcode_self_control: {
              type: 'http' as const,
              url: `${this.selfControlMcp.url}?sid=${encodeURIComponent(opts.sessionId)}`,
              headers: { authorization: `Bearer ${this.selfControlMcp.token}` },
            },
          },
        } : {}),
      };
    };

    // Constructs the SDK query exactly once, on the first send(). Never
    // called from interrupt()/setEffort()/setPermissionMode()/dispose() —
    // none of those should spawn a subprocess that was never asked to run.
    const ensureStarted = (): void => {
      if (started || disposed) { return; }
      started = true;
      pump = (async () => {
        try {
          const query = await this.loadQueryFn();
          const constructedOptions = buildOptions();
          const session = query({ prompt: prompts, options: constructedOptions });
          queryRef = session;
          resolveQueryReady?.(session);
          // The init message already produced a name+status snapshot via
          // map-events. This pull supersedes it with the full shape — error
          // text and a real tool count. Fire-and-forget: a failure here means
          // the strip keeps the coarser init data, which is a degraded strip
          // rather than a failed turn, so it must never surface as a
          // turn-end error and must never produce an unhandled rejection.
          // `mcpServerStatus()` is wrapped in try/catch, not just `.catch()`
          // on its result, because a call itself can throw synchronously
          // (e.g. an already-torn-down transport) — same reasoning as
          // setEffort/setPermissionMode below. A synchronous throw here, left
          // unguarded, would propagate out of this try and abort the pump
          // before it ever reaches the `for await` below, turning a merely
          // degraded strip into a fully failed turn.
          try {
            session.mcpServerStatus().then(
              (servers) => {
                if (disposed || servers.length === 0) { return; }
                events.push({
                  kind: 'mcp-servers',
                  servers: servers.map((s) => ({
                    name: s.name,
                    state: s.status === 'connected' || s.status === 'failed'
                      || s.status === 'needs-auth' || s.status === 'pending'
                      || s.status === 'disabled' ? s.status : 'pending',
                    ...(s.tools ? { toolCount: s.tools.length } : {}),
                    ...(s.error ? { error: redactSecrets(s.error) } : {}),
                  })),
                });
              },
              () => { /* see comment above: degraded strip, not a failed turn */ },
            ).catch(() => { /* belt-and-braces: .then's rejection handler itself must not throw async */ });
          } catch {
            // See comment above: a synchronous throw from the call itself is
            // exactly as non-fatal as an async rejection.
          }
          for await (const msg of session) {
            for (const event of mapEvent(msg)) {
              if (event.kind === 'background-tasks-changed') { backgroundTaskIds = event.taskIds; }
              // A genuine echo of a turn `interrupt()` already self-resolved:
              // harmless while the session is still idle (drainQueued() finds
              // nothing to spend), but a newer turn started since — turnGen
              // moved past what interrupt() captured — means this belongs to
              // the OLD turn and must not be mistaken for the new one's end.
              // See the turnGen doc comment above.
              if (
                event.kind === 'turn-end' && event.reason === 'interrupted'
                && interruptedGen !== undefined && interruptedGen !== turnGen
              ) { continue; }
              if (event.kind === 'turn-end' && event.reason === 'interrupted') { interruptedGen = undefined; }
              events.push(event);
            }
          }
        } catch (err) {
          const raw = errorMessage(err);
          events.push({ kind: 'turn-end', reason: 'error', error: authFailureReason(raw) ?? raw });
          // Unblocks a usageWindows() call that is awaiting this exact
          // construction — resolving to undefined so it degrades to "no
          // windows" rather than hanging on a query that will never exist.
          resolveQueryReady?.(undefined);
        } finally {
          events.close();
        }
      })();
    };

    return {
      events,
      send: (text: string, context?: EditorContext, attachments?: Attachment[]) => {
        turnGen += 1;
        ensureStarted();
        const body = context ? `${formatEditorContext(context)}\n\n${text}` : text;
        const content: ContentBlockParam[] = [
          { type: 'text', text: `${body}${attachmentLines(attachments)}` },
        ];
        for (const image of imageAttachments(attachments)) {
          const data = readBase64(image);
          if (!data) { continue; }
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: (image.mediaType ?? 'image/png') as 'image/png',
              data,
            },
          });
        }
        prompts.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        });
      },
      respondToTool: (id, decision) => {
        const entry = parked.get(id);
        if (entry?.kind === 'permission') { parked.delete(id); entry.resolve(decision); }
      },
      respondToQuestion: (id, answers) => {
        const entry = parked.get(id);
        if (entry?.kind === 'question') { parked.delete(id); entry.resolve(answers); }
      },
      setEffort: (next: EffortLevel) => {
        // `next` arrives unvalidated: the wire type (`set-effort`'s `effort`
        // field) carries the shared `EffortLevel` union with nothing tying a
        // value to a provider or model, and `AgentSession.setEffort` forwards
        // it verbatim (unlike `AgentSession.setModel`, which reconciles
        // through `resolveEffort` before assigning). The webview's slider
        // only offers levels the current model row publishes, so ordinary
        // use never reaches here with an unsupported value — but that is the
        // renderer policing a host invariant, and this file, not the
        // renderer, is the boundary that must not depend on it. Reconciling
        // here is the same call `buildOptions` makes for construction-time
        // effort: a Claude model's `effort.levels` never lists 'ultra', so
        // this clamp is what keeps it from ever reaching the SDK live, not
        // just at first send().
        const resolved = resolveEffort(findModel(this.listModels(), pendingModel), next);
        pendingEffort = resolved;
        if (!queryRef) {
          return; // not yet constructed: pendingEffort above is picked up at construction.
        }
        if (resolved === undefined) {
          // The model has no effort control at all (or the catalog has no
          // opinion) — nothing to send.
          return;
        }
        try {
          // Best-effort: an effort change that the SDK rejects (e.g. the model
          // doesn't support it) is not a failed agent turn, so it is not
          // surfaced as a turn-end error — logged only. See the header comment.
          // `resolved` is already narrowed to this model's levels above, so
          // this cast only bridges our `EffortLevel` type to the SDK's
          // otherwise-identical one — it is not doing any of the narrowing.
          queryRef.applyFlagSettings({ effortLevel: resolved as SdkEffortLevel }).catch((reason: unknown) => {
            console.warn('[mar-code] applyFlagSettings rejected', 'effort=', resolved, 'reason=', errorMessage(reason));
          });
        } catch (err) {
          // A synchronous throw (e.g. the query is already torn down) is
          // exactly as non-fatal as an async rejection above — same reason.
          console.warn('[mar-code] applyFlagSettings threw', 'effort=', resolved, 'error=', errorMessage(err));
        }
      },
      setModel: (next: string) => {
        pendingModel = next;
        if (!queryRef) {
          return; // not yet constructed: pendingModel above is picked up at construction.
        }
        try {
          // `Options.model` is read once, at construction — but `Query.setModel`
          // is a control-channel seam that retargets the *live* session, so a
          // mid-conversation switch is real rather than merely recorded. A turn
          // already in flight finishes on the old model; the next one uses this.
          //
          // Best-effort, same contract as setEffort/setPermissionMode: a model
          // the CLI refuses is a degraded setting, not a failed agent turn.
          queryRef.setModel(next).catch((reason: unknown) => {
            console.warn('[mar-code] setModel rejected', 'model=', next, 'reason=', errorMessage(reason));
          });
        } catch (err) {
          // Synchronous throw, same treatment as the async rejection above.
          console.warn('[mar-code] setModel threw', 'model=', next, 'error=', errorMessage(err));
        }
      },
      setPermissionMode: (mode: PermissionMode) => {
        pendingMode = mode;
        if (!queryRef) {
          return; // not yet constructed: pendingMode above is picked up at construction.
        }
        try {
          // Best-effort: a mode change the SDK rejects is not a failed agent
          // turn, so it is not surfaced as a turn-end error — same reasoning as
          // setEffort above.
          queryRef.setPermissionMode(PERMISSION_MODE[mode]).catch((reason: unknown) => {
            console.warn('[mar-code] setPermissionMode rejected', 'mode=', mode, 'reason=', errorMessage(reason));
          });
        } catch (err) {
          // Synchronous throw, same treatment as the async rejection above.
          console.warn('[mar-code] setPermissionMode threw', 'mode=', mode, 'error=', errorMessage(err));
        }
      },
      usageWindows: async (): Promise<UsageWindow[] | undefined> => {
        // Deliberately does NOT call ensureStarted(): a usage pull must never
        // be the thing that spawns a CLI subprocess for a session nobody has
        // sent to. Before the first send there is no query to ask, and the
        // activation probe already covers that case.
        if (!started || disposed) { return undefined; }
        // A send() just before this call has already kicked off
        // construction, but queryRef isn't assigned until a microtask later
        // (loadQueryFn() is itself async) — so a synchronous queryRef check
        // here would race that in-flight construction and lose it every
        // time. Await the same construction rather than reading queryRef
        // synchronously or starting a second one.
        const query = queryRef ?? await queryReady;
        if (!query || disposed) { return undefined; }
        return toUsageWindows(
          await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() as UsageResponseLike,
        );
      },
      contextBreakdown: async (): Promise<ContextBreakdown> => {
        // queryRef is only assigned once the query is constructed, which is
        // deferred to the first send. Before that there is genuinely nothing
        // to measure.
        if (!queryRef) { throw new Error('This session has not started yet'); }
        const res = await queryRef.getContextUsage();
        return toContextBreakdown(res as unknown as ContextUsageLike);
      },
      interrupt: async () => {
        for (const id of [...parked.keys()]) { cancelParked(id); }
        if (!queryRef) { return; } // nothing has ever run: a no-op, not a failure.
        try {
          // Stop every tracked background task first: `Query.interrupt()`
          // below only cancels the foreground turn, and a task the CLI
          // detached from it (Ctrl+B semantics) is specifically designed to
          // survive that call. Best-effort per task — one rejecting (e.g.
          // the task already settled and the id is stale) must not skip the
          // rest or block the foreground interrupt.
          for (const taskId of backgroundTaskIds) {
            try {
              await queryRef.stopTask(taskId);
            } catch {
              // Best-effort: see comment above.
            }
          }
          await queryRef.interrupt();
          // `queryRef.interrupt()` resolving only means the SDK accepted the
          // request — the turn-end that actually unwedges the session comes
          // later, async, from the SDK's own `result` message (mapped by
          // map-events.ts via `terminal_reason: 'aborted_streaming'/
          // 'aborted_tools'`). When that message is delayed or dropped this
          // session would otherwise stay `running`/`awaiting-approval`
          // forever, with a parked message never draining and Stop having
          // done nothing visible. Pushed unconditionally on the success path,
          // same as codex-run.ts's `interrupt()` — a later genuine result
          // message still arriving is a harmless second `turn-end` onto an
          // already-idle, already-drained session — UNLESS a newer turn has
          // started by the time it shows up, which is what `interruptedGen`
          // (checked in the `for await` loop above) exists to catch.
          interruptedGen = turnGen;
          events.push({ kind: 'turn-end', reason: 'interrupted' });
        } catch (err) {
          events.push({ kind: 'turn-end', reason: 'error', error: errorMessage(err) });
        }
      },
      dispose: async () => {
        if (disposed) { return; }
        disposed = true;
        for (const [, entry] of parked) {
          if (entry.kind === 'permission') { entry.resolve({ allow: false, reason: 'Session closed' }); }
          // CANCELLED, never `{}`: an empty answer map is a real answer here —
          // `canUseTool` turns it into `{behavior:'allow', updatedInput:{...input,
          // answers:{}}}`, i.e. "the user chose nothing, run the tool anyway",
          // which is exactly the shape this branch exists to avoid. The
          // sentinel resolves `deny` instead.
          else { entry.resolve(CANCELLED); }
        }
        parked.clear();
        prompts.close();
        try {
          queryRef?.close();
        } catch {
          // Best-effort: the process is being torn down regardless.
        }
        // If send() was never called, nothing ever closes `events` (the
        // query pump's own `finally` never runs) — AgentSession.dispose()
        // awaits this run's `events` draining to `done` via its own pump,
        // so closing here unconditionally is required to avoid hanging it
        // forever on a channel nothing else will ever close. Idempotent
        // with the pump's own close() when a query WAS constructed.
        events.close();
        await pump;
      },
    };
  }
}

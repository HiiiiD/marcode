import type {
  Attachment, AttachmentKind, ContextBreakdown, EditorContext, EffortLevel, FileEdit, Invocable,
  McpServerStatus, ModelInfo, PermissionMeta, PermissionMode, PermissionModeInfo, QuestionAnswers,
  QuestionOption, QuestionSpec, TodoStatus, ToolCall, ToolDecision, ToolOutput, UsageWindow,
} from '../providers/types';

export type {
  Attachment, AttachmentKind, ContextBreakdown, EditorContext, EffortLevel, FileEdit, Invocable,
  McpServerStatus, ModelInfo, PermissionMeta, PermissionMode, PermissionModeInfo, QuestionAnswers,
  QuestionOption, QuestionSpec, TodoStatus, ToolCall, ToolDecision, ToolOutput, UsageWindow,
};

export type SessionId = string;
export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error';

export type RefKind = 'message' | 'plan';

/**
 * A reference from one session's message to another session's output.
 *
 * `title` travels with the ref rather than being looked up: a transcript item
 * outlives the session it references, and a chip that renders "unknown
 * session" once the source is deleted records less than the one that kept the
 * name it had when the handoff happened.
 */
export interface SessionRef { sessionId: SessionId; kind: RefKind; title: string }

interface ItemBase { id: string; ts: number }

export type TranscriptItem =
  | (ItemBase & {
      role: 'user'; text: string;
      context?: EditorContext;
      /**
       * Sessions this message pulled from. Metadata about the message that
       * the message text cannot carry, exactly like `context` above — `text`
       * is already the fully-composed prompt the provider received.
       */
      refs?: SessionRef[];
      /**
       * Files this message carried. Metadata about the message exactly like
       * `context` and `refs` above — `text` is the fully-composed prompt, and
       * an attachment never appears in it: an image goes to the provider as a
       * native image input, and a file goes as a path line the provider adds.
       */
      attachments?: Attachment[];
    })
  | (ItemBase & { role: 'assistant'; text: string; thinking?: string })
  | (ItemBase & {
      role: 'tool'; toolId: string; tool: ToolCall;
      state: 'running' | 'ok' | 'error'; output?: ToolOutput;
      /**
       * A subagent's tool activity. Depth 1 only — a child never has children
       * of its own.
       */
      children?: TranscriptItem[];
    })
  /**
   * `meta` is what the backend's own permission engine already worked out
   * about the request — the sentence it would render, and why it is asking.
   * It rides the item as well as `SessionSnapshot.pending` so a settled or
   * reloaded card still reads the way the live one did; nothing in it is
   * user input, so persisting it is safe.
   */
  | (ItemBase & {
      role: 'permission'; requestId: string; tool: ToolCall;
      state: 'pending' | 'allowed' | 'denied'; reason?: string;
      meta?: PermissionMeta;
    })
  /**
   * A structured question from the agent. Blocking ones freeze the composer;
   * codex can send non-blocking ones. `answers` omits the key of any question
   * whose spec is `secret` — combined with `state: 'answered'` that reads as
   * "asked, answered, deliberately not recorded".
   */
  | (ItemBase & {
      role: 'question'; requestId: string; questions: QuestionSpec[]; blocking: boolean;
      state: 'pending' | 'answered' | 'cancelled' | 'stale';
      answers?: QuestionAnswers;
    })
  /**
   * An offer to follow an agent into a worktree it just created. Durable,
   * unlike a permission request: nothing is blocked on the answer, so it
   * survives a reload and stays meaningful when answered later. Answered
   * items render as their outcome, so the transcript reads as a record of
   * where the work happened.
   *
   * `queued` is the answer "move" given while a turn was still in flight —
   * the common case, since the offer is raised from a tool result *inside* a
   * turn. The move waits for idle, and the wait is state like everything
   * else: without it the card would go on asking a question the user has
   * already answered. It is the one state that describes something held in
   * host memory rather than on disk, so `SessionManager` returns any `queued`
   * item whose queue entry did not survive back to `pending` when the
   * transcript is read back.
   */
  | (ItemBase & {
      role: 'relocation'; path: string;
      state: 'pending' | 'queued' | 'moved' | 'stayed';
    })
  | (ItemBase & { role: 'error'; message: string });

export type TranscriptPatch =
  | { op: 'append'; item: TranscriptItem; parentItemId?: string }
  | { op: 'delta'; itemId: string; field: 'text' | 'thinking'; delta: string }
  | { op: 'replace'; item: TranscriptItem; parentItemId?: string };

export interface PermissionRequest { requestId: string; tool: ToolCall; meta?: PermissionMeta }
export interface QuestionRequest { requestId: string; questions: QuestionSpec[]; blocking: boolean }

export interface SessionState {
  id: SessionId;
  providerId: string;
  model: string;
  effort?: EffortLevel;
  title: string;
  cwd: string;
  status: SessionStatus;
  permissionMode: PermissionMode;
  /** Whether sends from this session attach the editor context. Sticky. */
  includeEditorContext: boolean;
  /**
   * One resume token per provider thread, keyed by `threadKey()`. A session
   * that has run in several working trees holds several, so returning to one
   * it has already used is a native resume rather than a replay.
   */
  resumeTokens: Record<string, string>;
  usage: { inputTokens: number; outputTokens: number };
  /**
   * Share of the model's context window in use, `100 - freePercent`.
   * Absent until the first turn ends, or forever for a provider that does
   * not report a breakdown.
   */
  contextPercent?: number;
  /**
   * The breakdown that `contextPercent` was computed from, kept whole so a
   * session restored after a reload can still answer `request-context`: the
   * Claude run is constructed lazily on the first `send()`, so a resumed
   * conversation has no live query to measure until it is used again, and
   * nothing about the context can change before that send. Host-side state:
   * it rides the wire because it lives on `SessionState`, but the webview
   * reads the breakdown only from the `context-breakdown` reply, which is
   * the one path that knows whether it came from a live query or the cache.
   */
  lastContext?: ContextBreakdown;
  /**
   * A message the user sent while the turn was still running, parked until
   * the session next goes idle — whether the turn ended on its own or the
   * user interrupted it. At most one: a second send while one is parked
   * replaces it, so what the composer shows is always what will be sent.
   *
   * Host state on the wire so the chip survives a reload like everything
   * else. The editor context captured alongside it stays host-side: it is
   * only ever handed to the provider, and the webview has no use for it.
   *
   * `attachments` is captured at queue time, same as `refs` — the pending
   * set at the moment this message was parked, not whatever the live set
   * holds when it is finally delivered. An attachment added while this is
   * already queued belongs to the *next* turn, not this one, so it must not
   * be read off the live set again on delivery.
   */
  queued?: { text: string; refs?: SessionRef[]; attachments?: Attachment[] };
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export type SessionSummary = SessionState;

export interface SessionSnapshot extends SessionState {
  /** Recent window, oldest-first. */
  items: TranscriptItem[];
  /** More history available before items[0]. */
  hasMore: boolean;
  pending: PermissionRequest[];
  /**
   * Questions parked on the live run, exactly like `pending` above and
   * deliberately alongside it rather than on `SessionState`: both describe a
   * provider request waiting on an answer *right now*, which is in-memory
   * host state that `index.json` must not claim to know. A field on
   * `SessionState` would ride every `sessions-changed` summary and every
   * persisted entry reading `[]` while a question was in fact parked.
   */
  pendingQuestions: QuestionRequest[];
  /**
   * The cwd's catalog, when the host has one. In-memory host state: absent
   * before the probe resolves, and absent forever if it failed.
   */
  invocables?: Invocable[];
  /**
   * Live provider state, not persisted. Always [] for an archived session —
   * there is no run to ask, and a stale snapshot presented as current would
   * be a lie. Deliberately NOT on SessionState, which is what index.json
   * stores.
   */
  mcpServers: McpServerStatus[];
  /**
   * Composed but not yet sent. Live host state like `mcpServers`, deliberately
   * not on SessionState (which is what index.json stores) — but it does
   * outlive a webview reload, because the extension host does.
   */
  pendingAttachments: Attachment[];
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  models: ModelInfo[];
  /**
   * The modes this provider offers. Rides the existing `hydrate` and
   * `catalog` messages because it lives on `ProviderInfo` — a mode set that
   * arrived out of step with the catalog it belongs to would let the picker
   * offer one provider's modes for another's session.
   */
  permissionModes: PermissionModeInfo[];
}

/**
 * A configured provider the host cannot currently honor — its backend did not
 * answer, so nothing it could offer would be true.
 *
 * It is deliberately NOT a `ProviderInfo` with an empty `models`: the catalog
 * is the set of things that can be picked, and anything in it is selectable.
 * These travel alongside it instead, for the one thing they are good for —
 * telling the user why an expected provider is missing.
 */
export interface UnavailableProvider {
  id: string;
  displayName: string;
  /** One line, provider-authored and already redacted. Shown verbatim. */
  reason: string;
}

export type ContextResult =
  | { ok: true; breakdown: ContextBreakdown }
  | { ok: false; reason: string };

/**
 * Whether a worktree's branch can be moved back into its main working tree,
 * and — when it cannot — the one line that says why.
 *
 * `isWorktree` rides the refusal because the two kinds of "no" are not the
 * same product state. "This is not a linked worktree" means there is nothing
 * to offer and the UI must not show a door at all; "the main tree is dirty"
 * means the door is right but the moment is wrong, and the user needs to read
 * the reason. Without the flag the panel would have to parse prose to tell
 * them apart.
 *
 * Declared here rather than in `src/host/git-worktree.ts` (which produces it)
 * because it crosses the wire: this is the one module both bundles import,
 * and the webview must never reach into the host's git layer for a type.
 */
export type BringBackPlan =
  | { ok: true; branch: string; worktree: string; mainRoot: string }
  | { ok: false; reason: string; isWorktree: boolean };

/**
 * One linked worktree the panel knows about, and whether it can be swept away.
 *
 * "Knows about" is the union of every directory a session is sitting in and
 * every directory a session still holds a resume token for — the two ways a
 * tree ends up outliving the work that created it. `sessionId` is the session
 * *currently* in it; its absence is what makes a row stale rather than in use,
 * and it is why the sweep exists at all: a tree nobody occupies has no pane
 * header to offer the bring-back door from.
 *
 * `reason` is `bringBackPlan`'s refusal, carried verbatim. Removal here is the
 * same operation with the same preconditions, so a second set of safety checks
 * would only be a second set of things to disagree.
 */
export interface StaleTree {
  path: string;
  branch?: string;
  clean: boolean;
  /** The session sitting in this directory now, or absent when none is. */
  sessionId?: SessionId;
  /** Absent when it can be removed; the one line refusing it otherwise. */
  reason?: string;
}

export type ChangeOp = 'create' | 'modify' | 'delete' | 'rename';

/**
 * How a tree's diff was anchored. Named rather than inline because the UI
 * quotes it: `head` means the diff shows uncommitted work only, which is a
 * materially different reading of a session than "everything since the
 * branch point", and a number nobody can locate is not an answer.
 */
export type DiffBase =
  | { kind: 'merge-base'; ref: string; sha: string }
  | { kind: 'head' };

export interface FileChange {
  /** Repo-relative, POSIX separators — the spelling git reports. */
  path: string;
  /** Set only for a rename; the path the file moved from. */
  from?: string;
  op: ChangeOp;
  /** Undefined for a binary file, where git reports no line counts. */
  insertions?: number;
  deletions?: number;
  /**
   * Sessions whose transcripts claim a write to this path. Empty is a real
   * answer, not a gap: a change made by a shell command, a build or the user
   * has no tool call behind it and no session may be named for it.
   */
  claimedBy: SessionId[];
}

export interface TreeDiff {
  /** Resolved absolute path of the working tree root. */
  root: string;
  branch?: string;
  /** Sessions occupying this tree, roster order. */
  sessions: SessionId[];
  base: DiffBase;
  files: FileChange[];
  /** Files beyond the render cap, omitted from `files`. Never truncate silently. */
  omitted: number;
  /** Why this tree has no diff. Set means `files` is empty. */
  reason?: string;
}

export interface PaneLayout {
  orientation: 'vertical' | 'horizontal';
  panes: { sessionId: SessionId; size: number }[];
}

export type WebviewToHost =
  | { t: 'ready' }
  /**
   * `mode` is the permission mode the session starts in. It is optional and
   * defaults to `'default'` on the host, because a caller that has no
   * opinion must not be able to start a session in `bypass` by omission —
   * and `bypass` can only ever be chosen *before* the first message, so
   * creation is the one point on the wire where it is settable at all.
   */
  | { t: 'create-session'; providerId: string; cwd: string; model?: string;
      effort?: EffortLevel; mode?: PermissionMode;
      /**
       * The new session's first message, sent immediately after creation.
       * Carried on creation rather than posted as a follow-up `send` because
       * the webview does not know the new session's id until the host has
       * made it — a two-step version would have to wait for the snapshot and
       * would lose the seed if the panel reloaded in between.
       */
      seed?: { text: string; refs: SessionRef[] } }
  | { t: 'set-visible'; sessionIds: SessionId[] }
  | { t: 'set-layout'; layout: PaneLayout }
  | { t: 'close-session'; id: SessionId }
  | { t: 'delete-session'; id: SessionId }
  | { t: 'send'; id: SessionId; text: string; refs?: SessionRef[] }
  | { t: 'interrupt'; id: SessionId }
  /** Drops `SessionState.queued`. Nothing was appended, so nothing is undone. */
  | { t: 'cancel-queued'; id: SessionId }
  | { t: 'set-effort'; id: SessionId; effort: EffortLevel }
  | { t: 'set-permission-mode'; id: SessionId; mode: PermissionMode }
  | { t: 'set-include-context'; id: SessionId; on: boolean }
  /**
   * Pasted bytes cross the wire once; the host persists them and mints the
   * attachment.
   *
   * `name` is absent for a clipboard image, which usually has none. The host
   * numbers those against the pending set rather than the webview doing it,
   * because two pastes in flight would both read the same length and pick the
   * same number.
   */
  | { t: 'attach-paste'; id: SessionId; name?: string; mediaType?: string; base64: string }
  | { t: 'attach-pick'; id: SessionId }
  /** Unparsed URI-list entries from a drop. */
  | { t: 'attach-drop'; id: SessionId; uris: string[] }
  | { t: 'attach-remove'; id: SessionId; attachmentId: string }
  /**
   * A clipboard or dropped `File` the webview could not read, so no bytes
   * ever reached the host.
   *
   * Reported rather than handled in the composer because the host owns the
   * rejection line: a webview that rendered this one failure from local state
   * would be the only thing on this surface holding an error the host has
   * never heard of.
   */
  | { t: 'attach-failed'; id: SessionId; name: string }
  /** Not session-addressed: opening a file is global IDE state, not session state. */
  | { t: 'reveal-file'; path: string; startLine?: number }
  | { t: 'set-model'; id: SessionId; model: string }
  | { t: 'permission-decision'; id: SessionId; requestId: string; decision: ToolDecision }
  | { t: 'question-answer'; id: SessionId; requestId: string; answers: QuestionAnswers }
  | { t: 'load-more'; id: SessionId; beforeItemId: string }
  | { t: 'request-context'; id: SessionId }
  /**
   * Distinct from `reveal-file`, which opens an editor-context path the host
   * itself produced. `path` here originates in a *provider's* context report,
   * so it is carried back with the session that reported it: the host opens
   * it only if that session's most recent breakdown actually listed it.
   * Hence the `SessionId`, which also keeps this in line with the "every
   * session-addressed message carries an explicit id" rule.
   */
  | { t: 'open-file'; id: SessionId; path: string }
  | { t: 'answer-relocation'; id: SessionId; itemId: string; move: boolean }
  /**
   * "Not any more." Calls off a move that is waiting for the turn to finish
   * and puts the offer back to `pending`. Deliberately not `answer-relocation`
   * with `move: false`: that is Stay, an answer, and it settles the item
   * forever. This one un-answers it — a deferred action the user cannot call
   * off is worse than no deferral at all.
   */
  | { t: 'cancel-relocation'; id: SessionId; itemId: string }
  /**
   * "Could this session's branch come home?" — a question, with no side
   * effects beyond reading git. Answered by `bring-back-plan`.
   */
  | { t: 'request-bring-back'; id: SessionId }
  /**
   * "Do it." The host re-plans before acting: the dialog that posted this may
   * have been open for minutes, and the plan it displayed is a description of
   * a past state, never an authorization.
   */
  | { t: 'bring-back'; id: SessionId }
  /**
   * "Which working trees does this panel still touch?" Read-only, and
   * deliberately not session-addressed: the answer spans every session's
   * directories at once, and the rows that matter most are the ones no
   * session is in.
   */
  | { t: 'request-stale-trees' }
  /**
   * "Sweep this one." Addressed by path rather than by session for the same
   * reason. The host re-plans before acting and refuses through the refreshed
   * sweep, exactly as `bring-back` re-plans and refuses through a fresh plan.
   */
  | { t: 'remove-stale-tree'; path: string }
  /**
   * "What has the fleet changed?" Read-only and deliberately not
   * session-addressed: a working tree is the unit git can answer for, and
   * two sessions sharing one tree share one answer.
   */
  | { t: 'request-fleet-diff' }
  /**
   * Open one file's change in VS Code's own diff editor. Carries the tree
   * because a repo-relative path is meaningless without it, and the base
   * because the left-hand side is that file at the branch point.
   */
  | { t: 'open-file-diff'; root: string; path: string; base: DiffBase }
  /**
   * "Ask the backends again." Re-probing is the whole mechanism for
   * re-checking an install (see `SessionManager.refreshModels`), so the empty
   * state's retry is this and nothing else — there is no separate
   * availability call for the webview to make.
   */
  | { t: 'refresh-catalog' }
  /**
   * Open VS Code's settings UI at `section`. The webview cannot run a
   * command, and the one place it needs to is the empty state: with no
   * provider enabled, the setting that enables one is the only next step.
   */
  | { t: 'open-settings'; section: string }
  /**
   * A URL from agent-authored markdown, handed to the OS. Not
   * session-addressed for the same reason `reveal-file` is not: where a link
   * goes is global IDE state, and no session owns the browser.
   *
   * The webview has already ruled out the schemes that name a script rather
   * than a destination (`markdown-link.ts`); VS Code applies its own
   * trusted-domain prompt to what survives.
   */
  | { t: 'open-external'; url: string };

export type HostToWebview =
  | { t: 'hydrate'; sessions: SessionSummary[]; layout: PaneLayout;
      snapshots: SessionSnapshot[]; catalog: ProviderInfo[];
      /**
       * Providers that cannot be picked, and why. Empty at hydrate on a
       * healthy install *and* on a broken one — nothing has been probed yet,
       * so the honest answer is "no catalog, no reasons"; the first `catalog`
       * message fills both in.
       */
      unavailable: UnavailableProvider[];
      /** See `catalog`'s field of the same name. True at hydrate whenever the
       * host is about to probe, which is every hydrate with a provider
       * configured. */
      probing?: boolean;
      /** Per provider, the last window set the host knew. Empty on a fresh install. */
      usage: Record<string, UsageWindow[]> }
  | { t: 'session-snapshot'; session: SessionSnapshot }
  | { t: 'session-patch'; id: SessionId; patch: TranscriptPatch }
  | { t: 'session-prepend'; id: SessionId; items: TranscriptItem[]; hasMore: boolean }
  | { t: 'session-status'; id: SessionId; status: SessionStatus }
  | { t: 'sessions-changed'; sessions: SessionSummary[] }
  | { t: 'session-invocables'; id: SessionId; entries: Invocable[] }
  | { t: 'session-mcp'; id: SessionId; servers: McpServerStatus[] }
  /** Full replacement of the host-owned pending attachment set. */
  | { t: 'session-attachments'; id: SessionId; attachments: Attachment[] }
  /**
   * A transient composer error; the session itself remains usable.
   *
   * One composed sentence per refused file rather than one for the batch: a
   * drop of four can fail four different ways, and a single count names
   * neither which file nor which constraint.
   */
  | { t: 'attachments-rejected'; id: SessionId; reasons: string[] }
  /**
   * Broadcast, not session-addressed: the provider/model catalog is global.
   * Sent after `hydrate` whenever a provider reports a catalog that differs
   * from the one it could answer with synchronously — model lists come from
   * the backend, so `hydrate` can only carry a provisional list.
   *
   * Both arrays are full replacements, never deltas, and they partition the
   * configured providers: a provider is in exactly one of them.
   */
  | { t: 'catalog'; catalog: ProviderInfo[]; unavailable: UnavailableProvider[];
      /**
       * Whether a probe is still in flight. An empty catalog means two very
       * different things one second apart — "nobody has answered yet" and
       * "nothing here can run an agent" — and only the second one is a
       * diagnosis worth showing. Absent is read as "still probing": a client
       * that has never been told otherwise has not been told the answer
       * settled.
       */
      probing?: boolean }
  /** Broadcast, not session-addressed: every composer shows the same editor. */
  | { t: 'editor-context'; ctx: EditorContext | null }
  | { t: 'context-breakdown'; id: SessionId; result: ContextResult }
  /**
   * Broadcast, not session-addressed, and not a reply: account usage belongs
   * to the provider's account, and it is pushed whenever the provider reports
   * a change. The array is the complete current set for that provider — a
   * snapshot, never a delta — so the client replaces rather than merges.
   * There is no not-ok arm: under a push there is no request that can fail,
   * and "nothing has been reported" is a state, not an error.
   */
  | { t: 'usage-windows'; providerId: string; windows: UsageWindow[] }
  /**
   * The answer to `request-bring-back`, and also what a *failed* `bring-back`
   * replies with — a refusal is the same shape whether it was found by asking
   * or by trying, and the dialog that is still on screen should show it either
   * way rather than sitting on the plan that has just been overtaken.
   */
  | { t: 'bring-back-plan'; id: SessionId; plan: BringBackPlan }
  /**
   * The answer to `request-stale-trees`, and also what a `remove-stale-tree`
   * replies with — success and refusal are the same shape here, because the
   * refusal *is* a row: the tree is still listed, still dirty, and the reason
   * it could not go is the line it now carries. A complete replacement, never
   * a delta.
   */
  | { t: 'stale-trees'; trees: StaleTree[] }
  /**
   * The answer to `request-fleet-diff`. A complete replacement, never a
   * delta: it describes disk at an instant, and a merged delta would let a
   * stale row outlive the change it described.
   */
  | { t: 'fleet-diff'; trees: TreeDiff[];
      /**
       * Why the whole read failed; `trees` is empty when it is set. The
       * per-tree counterpart of `TreeDiff.reason`, and it exists for the same
       * reason: errors are state, never exceptions. Without it a read that
       * threw before any tree was reached would emit nothing at all, and the
       * surface would sit on "Reading the working trees…" for the life of the
       * webview — the one sentence a failure must never be allowed to leave
       * on screen.
       */
      reason?: string };

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SessionManager } from './session-manager';
import type { AgentSession } from './agent-session';
import { MAX_PENDING, type AttachmentStore } from './attachment-store';
import type {
  DiffBase, EditorContext, FileRef, HostToWebview, SessionId, SessionRef, SessionSnapshot,
  WebviewToHost,
} from '../protocol/messages';
import { fsPathOfUri } from './file-uri';
import { composePrompt, resolveFileRefs } from './session-refs';

/**
 * Why a message with references was not sent. One function, called from both
 * the `send` and the `create-session` paths: the two carried the sentence
 * verbatim, which is how one of them came to read "…from a (message), b
 * (plan). That session has not produced one yet."
 *
 * The subject counts distinct sessions rather than references, since one
 * session can be missing both its last reply and its last plan.
 */
function missingRefsMessage(missing: SessionRef[]): string {
  const names = missing.map((r) => `${r.title} (${r.kind})`).join(', ');
  const subject = new Set(missing.map((r) => r.sessionId)).size === 1
    ? 'That session has'
    : 'Those sessions have';
  const object = missing.length === 1 ? 'one' : 'them';
  return `Nothing to hand off from ${names}. ${subject} not produced ${object} yet.`;
}

/** Same all-or-nothing shape as `missingRefsMessage`, for `@file` mentions. */
function missingFileRefsMessage(missing: FileRef[]): string {
  const names = missing.map((r) => r.path).join(', ');
  const subject = missing.length === 1 ? 'That file' : 'Those files';
  return `Could not read ${names}. ${subject} no longer exist at that path.`;
}

/**
 * "What files match this?" — the router's own dependency, kept as narrow as
 * `EditorContextHost`: it needs `vscode.workspace.findFiles`, which this
 * module must not import. `src/extension.ts` supplies the real one, backed
 * by `WorkspaceFileIndex` in `file-index.ts`.
 */
export interface FileSearch {
  search(query: string): Promise<FileRef[]>;
}

/**
 * The router must stay free of `vscode` (it has unit tests that run outside
 * the extension host), so everything needing the real editor API arrives
 * through this. `src/extension.ts` supplies the real implementation.
 */
export interface EditorContextHost {
  current(): EditorContext | null;
  reveal(path: string, startLine?: number): void;
  /**
   * Opens `path` in VS Code's diff editor, against its content at `base`.
   * Here rather than in the router because it needs the `vscode` API, which
   * this module must not import; `src/extension.ts` supplies the real one.
   */
  openDiff(root: string, path: string, base: DiffBase): void;
  /**
   * Reveals `section` in VS Code's settings UI. Here for the same reason
   * `openDiff` is — it needs `vscode.commands`, which this module must not
   * import — even though settings are not the editor. The alternative was a
   * seventh constructor parameter for one call site.
   */
  openSettings(section: string): void;
  /**
   * Opens `url` outside VS Code. Here for the same reason `openDiff` is: it
   * needs `vscode.env`, which this module must not import.
   */
  openExternal(url: string): void;
  /**
   * Saves `csv` to a file the user picks. Here for the same reason
   * `openDiff` is — it needs `vscode.window.showSaveDialog`, which this
   * module must not import.
   */
  exportCsv(csv: string): void;
  /**
   * Opens a terminal and runs the given provider's sign-in flow. Here for
   * the same reason `openSettings` is — it needs `vscode.window.createTerminal`,
   * which this module must not import. Login is a browser/TTY flow the
   * extension cannot drive headlessly, so this is a terminal handoff, not a
   * result: the webview's own `refresh-catalog` retry is what notices it
   * worked.
   */
  login(providerId: string): void;
}

const NO_EDITOR: EditorContextHost = {
  current: () => null,
  reveal: () => {},
  openDiff: () => {},
  openSettings: () => {},
  openExternal: () => {},
  exportCsv: () => {},
  login: () => {},
};

export interface AttachmentHost { pick(): Promise<string[]> }

const NO_PICKER: AttachmentHost = { pick: async () => [] };

/**
 * Persists `marcode.favoriteModels`. Here for the same reason
 * `EditorContextHost` exists — writing a VS Code setting needs the `vscode`
 * API, which this module must not import.
 */
export interface ConfigHost { setFavoriteModels(ids: string[]): void }

const NO_CONFIG: ConfigHost = { setFavoriteModels: () => {} };

export class MessageRouter {
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly defaultCwd: string,
    private readonly editor: EditorContextHost = NO_EDITOR,
    private readonly attachments?: AttachmentStore,
    private readonly picker: AttachmentHost = NO_PICKER,
    /**
     * `marcode.review.pollIntervalMs`, echoed onto every `hydrate` — see
     * `HostToWebview`'s `reviewPollIntervalMs` field for why it rides the
     * shared message rather than a review-only one.
     */
    private readonly reviewPollIntervalMs: number = 750,
    private readonly fileSearch?: FileSearch,
    /**
     * `marcode.favoriteModels` as read at construction. Mutable from here on:
     * `set-favorite-models` updates it in place so a `ready` from a second
     * pane opened later in the same session hydrates with the current list,
     * not the one the extension started with.
     */
    private favoriteModels: string[] = [],
    private readonly configHost: ConfigHost = NO_CONFIG,
  ) {}

  /**
   * Errors are state, never exceptions: this is called directly from
   * `webview.onDidReceiveMessage`, and `create-session` (unknown providerId)
   * and `open()` (unknown/unknown-state SessionId, reached via `send` on a
   * restored-but-not-materialized session) are the two SessionManager calls
   * that can throw. A rejection escaping here would surface as an unhandled
   * promise rejection at the VS Code callback site, so every branch runs
   * under a single catch-all: a failed message is logged and dropped as a
   * no-op rather than ever rejecting out of `handle()`.
   */
  async handle(msg: WebviewToHost): Promise<void> {
    try {
      await this.route(msg);
    } catch (err) {
      // `msg` itself can be why this failed (e.g. `msg` is null, or `msg.t`
      // isn't a recognized case) — dereference defensively so the catch
      // block can never itself throw and reject handle().
      console.error('[mar-code] message-router: failed to handle', msg?.t, err);
    }
  }

  private async route(msg: WebviewToHost): Promise<void> {
    if (!isWireMessage(msg)) {
      console.error('[mar-code] message-router: dropping malformed message', msg);
      return;
    }

    switch (msg.t) {
      case 'ready': {
        const layout = this.manager.layout();
        const snapshots: SessionSnapshot[] = [];
        // A pane can outlive close-session (only delete-session prunes the
        // layout), so a pane's sessionId may point at an archived session.
        // Only the genuine "live at shutdown, restored with no live
        // AgentSession yet" case should be materialized via reopen() here —
        // an explicitly-closed session must stay archived and provider-run
        // free until the user re-opens it (e.g. via set-visible, which
        // already serves archived sessions from disk without reviving them).
        const archived = new Set(
          this.manager.summaries().filter((s) => s.archived).map((s) => s.id),
        );
        for (const pane of layout.panes) {
          if (archived.has(pane.sessionId)) { continue; }
          const session = this.manager.get(pane.sessionId) ?? await this.reopen(pane.sessionId);
          if (session) { snapshots.push(await session.snapshot()); }
        }
        this.emit({
          t: 'hydrate',
          sessions: this.manager.summaries(),
          layout,
          snapshots,
          catalog: this.manager.catalog(),
          unavailable: this.manager.unavailable(),
          // Asked before the probe below is fired, and answered by the
          // provider set rather than by a flag: an empty catalog at hydrate
          // is a pending question on a normal install and a settled answer on
          // one with no provider enabled, and only the second one is
          // something to tell the user about.
          probing: this.manager.willProbe(),
          usage: this.manager.usageSnapshot(),
          reviewPollIntervalMs: this.reviewPollIntervalMs,
          favoriteModels: this.favoriteModels,
        });
        this.emit({ t: 'editor-context', ctx: this.editor.current() });
        // Not awaited: hydrate must not wait on a CLI handshake. The catalog
        // just sent carries each provider's synchronously-known models, or —
        // for a backend-answered one, which knows nothing until its first
        // probe lands — the list its last successful probe left on disk. That
        // seed is why a restored panel comes up with a live model switcher
        // rather than a read-only pane. The authoritative catalog, and any
        // unavailability reason, replace it in a `catalog` message when the
        // probes settle; see SessionManager.seededModels.
        void this.manager.refreshModels(this.defaultCwd);
        void this.manager.refreshUsage(this.defaultCwd);
        return;
      }

      case 'create-session': {
        const session = await this.manager.create(
          msg.providerId, msg.cwd || this.defaultCwd, msg.model, msg.effort, msg.mode,
        );
        if (msg.seed) {
          const fileRefs = msg.seed.fileRefs ?? [];
          const [{ blocks: sBlocks, missing: sMissing }, { blocks: fBlocks, missing: fMissing }] =
            await Promise.all([
              this.manager.resolveRefs(msg.seed.refs),
              this.resolveFileRefsFor(session, fileRefs),
            ]);
          if (sMissing.length > 0 || fMissing.length > 0) {
            session.noteError(this.missingMessage(sMissing, fMissing));
          } else {
            const context = session.state.includeEditorContext
              ? this.editor.current() ?? undefined
              : undefined;
            session.send(
              composePrompt(msg.seed.text, [...sBlocks, ...fBlocks]), context,
              msg.seed.refs.length > 0 ? msg.seed.refs : undefined,
              fileRefs.length > 0 ? fileRefs : undefined,
            );
          }
        }
        this.emit({ t: 'session-snapshot', session: await session.snapshot() });
        return;
      }

      case 'set-visible':
        await this.manager.setVisible(msg.sessionIds);
        return;

      case 'set-layout':
        this.manager.setLayout(msg.layout);
        return;

      case 'close-session':
        await this.manager.close(msg.id);
        return;

      case 'delete-session':
        await this.manager.remove(msg.id);
        return;

      case 'send': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const context = session.state.includeEditorContext
          ? this.editor.current() ?? undefined
          : undefined;

        const refs = msg.refs ?? [];
        const fileRefs = msg.fileRefs ?? [];
        if (refs.length === 0 && fileRefs.length === 0) {
          session.send(msg.text, context);
          return;
        }

        const [{ blocks: sBlocks, missing: sMissing }, { blocks: fBlocks, missing: fMissing }] =
          await Promise.all([
            this.manager.resolveRefs(refs),
            this.resolveFileRefsFor(session, fileRefs),
          ]);
        // All or nothing. A prompt that says "implement the plan above" with
        // no plan above is an invitation to invent one, which is worse than
        // not sending at all.
        if (sMissing.length > 0 || fMissing.length > 0) {
          session.noteError(this.missingMessage(sMissing, fMissing));
          return;
        }
        session.send(
          composePrompt(msg.text, [...sBlocks, ...fBlocks]), context,
          refs.length > 0 ? refs : undefined,
          fileRefs.length > 0 ? fileRefs : undefined,
        );
        return;
      }

      case 'interrupt':
        await this.manager.get(msg.id)?.interrupt();
        return;

      // No `reopen`: only a live session can be holding a parked message.
      case 'cancel-queued':
        this.manager.get(msg.id)?.cancelQueued(msg.messageId);
        return;

      case 'set-effort': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        session?.setEffort(msg.effort);
        return;
      }

      case 'set-permission-mode': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        session?.setPermissionMode(msg.mode);
        return;
      }

      case 'set-model': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        session?.setModel(msg.model);
        return;
      }

      case 'set-include-context': {
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        session?.setIncludeEditorContext(msg.on);
        return;
      }

      case 'attach-paste': {
        if (!this.attachments) { return; }
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        if (session.pendingAttachments.length >= MAX_PENDING) {
          this.emit({
            t: 'attachments-rejected', id: msg.id,
            reasons: ['A turn can carry up to 10 attachments.'],
          });
          return;
        }
        // Numbered here, where the pending set is known and handling is
        // sequential: the webview cannot count two in-flight pastes apart.
        const name = msg.name || `Pasted image ${session.pendingAttachments.length + 1}`;
        const saved = await this.attachments.savePaste(msg.id, { ...msg, name });
        if ('error' in saved) {
          this.emit({ t: 'attachments-rejected', id: msg.id, reasons: [saved.error] });
          return;
        }
        session.addAttachments([saved]);
        this.emitAttachments(session, msg.id);
        return;
      }

      case 'attach-pick': {
        if (!this.attachments) { return; }
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const picked = await this.picker.pick();
        if (picked.length === 0) { return; }
        await this.adopt(session, msg.id, picked);
        return;
      }

      case 'attach-drop': {
        if (!this.attachments) { return; }
        const session = this.manager.get(msg.id) ?? await this.reopen(msg.id);
        if (!session) { return; }
        const paths = msg.uris.map(fsPathOfUri).filter((path): path is string => path !== undefined);
        if (paths.length === 0) {
          this.emit({
            t: 'attachments-rejected', id: msg.id,
            reasons: ['That drop carried nothing on disk.'],
          });
          return;
        }
        await this.adopt(session, msg.id, paths);
        return;
      }

      case 'attach-remove': {
        const session = this.manager.get(msg.id);
        if (!session) { return; }
        session.removeAttachment(msg.attachmentId);
        this.emitAttachments(session, msg.id);
        return;
      }

      case 'attach-failed': {
        // Nothing to store and nothing to reject — the bytes never arrived.
        // The host still owns the sentence, so the composer has exactly one
        // place errors come from, whichever side noticed the failure.
        this.emit({
          t: 'attachments-rejected', id: msg.id,
          reasons: [`${msg.name} — could not be read`],
        });
        return;
      }

      case 'reveal-file':
        this.editor.reveal(msg.path, msg.startLine);
        return;

      // Awaited rather than fire-and-forget: `relocate` disposes and rebuilds
      // a session, and a rejection escaping a `void` here would be an
      // unhandled rejection at the `webview.onDidReceiveMessage` callback.
      // Awaiting puts it inside `handle()`'s catch-all, like every other case.
      case 'answer-relocation':
        await this.manager.relocate(msg.id, msg.itemId, msg.move);
        return;

      // Awaited for the same reason, though this one only rewrites a
      // transcript item: it is the same catch-all that keeps a store write
      // failing on disk from escaping as an unhandled rejection.
      case 'cancel-relocation':
        await this.manager.cancelRelocation(msg.id, msg.itemId);
        return;

      // Awaited for the same reason: `fork` writes the new session's
      // transcript to disk before returning, and a `void` here would put
      // that rejection outside `handle()`'s catch-all. No reply beyond the
      // `sessions-changed` `fork()` already fires through `changed()`.
      case 'fork-session':
        await this.manager.fork(msg.id, msg.itemId);
        return;

      // Both awaited for the same reason as `answer-relocation`: they shell
      // out to git and touch the filesystem, and a `void` here would put a
      // rejection outside `handle()`'s catch-all.
      case 'request-bring-back':
        await this.manager.requestBringBack(msg.id);
        return;

      case 'bring-back':
        await this.manager.bringBack(msg.id);
        return;

      // Awaited for the same reason, and neither carries a SessionId: the
      // sweep is panel-wide, and the rows that matter most are the ones no
      // session is in.
      case 'request-stale-trees':
        await this.manager.requestStaleTrees();
        return;

      case 'remove-stale-tree':
        await this.manager.removeStaleTree(msg.path);
        return;

      // Awaited for the same reason as the sweep — it shells out to git — and
      // unaddressed for the same reason too: a working tree is the unit git
      // can answer for, and two sessions in one tree share one answer.
      case 'request-fleet-diff':
        await this.manager.requestFleetDiff(msg.cap);
        return;

      case 'open-file-diff':
        this.editor.openDiff(msg.root, msg.path, msg.base);
        return;

      // Awaited, unlike the fire-and-forget probe at hydrate: this one was
      // asked for, and its `catalog` emit is the only feedback the retry has.
      case 'refresh-catalog':
        await this.manager.refreshModels(this.defaultCwd);
        return;

      case 'open-settings':
        this.editor.openSettings(msg.section);
        return;

      case 'login-provider':
        this.editor.login(msg.providerId);
        return;

      case 'open-external':
        this.editor.openExternal(msg.url);
        return;

      case 'export-table-csv':
        this.editor.exportCsv(msg.csv);
        return;

      case 'set-favorite-models':
        this.favoriteModels = msg.ids;
        this.configHost.setFavoriteModels(msg.ids);
        this.emit({ t: 'favorite-models', ids: msg.ids });
        return;

      case 'permission-decision':
        this.manager.get(msg.id)?.respondToPermission(msg.requestId, msg.decision);
        return;

      case 'question-answer':
        this.manager.get(msg.id)?.answerQuestion(msg.requestId, msg.answers);
        return;

      case 'load-more': {
        const session = this.manager.get(msg.id);
        if (!session) { return; }
        const { items, hasMore } = await session.loadMore(msg.beforeItemId);
        this.emit({ t: 'session-prepend', id: msg.id, items, hasMore });
        return;
      }

      case 'request-context': {
        const result = await this.manager.contextBreakdown(msg.id);
        this.emit({ t: 'context-breakdown', id: msg.id, result });
        return;
      }

      // PanelViewProvider intercepts this before delegating (it needs the
      // `vscode` API, which this module must not import) and is also where
      // `msg.path` is validated against the memory files `msg.id` reported —
      // that check stays on the provider/manager side for the same reason.
      // It is listed here, and in KNOWN_MESSAGE_TAGS, so a stray one is a
      // deliberate no-op rather than a "malformed message" error log.
      case 'open-file':
        return;

      // Same precedent as `open-file` above: `PanelViewProvider` intercepts
      // this before delegating, since opening the review tab needs the
      // `vscode` API this module must not import. Listed here, and in
      // KNOWN_MESSAGE_TAGS, so a stray one — this router also backs
      // `ReviewPanel` itself, where nothing intercepts it — is a deliberate
      // no-op rather than a "malformed message" error log.
      case 'open-review':
        return;

      // Same precedent as open-review: PanelViewProvider intercepts this
      // before delegating, since opening the fleet tab needs the vscode API
      // this module must not import.
      case 'open-fleet':
        return;

      // Same precedent as open-fleet: PanelViewProvider intercepts this
      // before delegating, since opening the fleet tab at a specific
      // subagent needs the vscode API this module must not import.
      case 'open-fleet-subagent':
        return;

      // Same precedent as open-review: FleetPanel intercepts this before
      // delegating, since revealing the sidebar view container needs the
      // vscode API this module must not import. Listed here, and in
      // KNOWN_MESSAGE_TAGS, so a stray one — this router also backs
      // PanelViewProvider itself, where nothing intercepts it — is a
      // deliberate no-op rather than a "malformed message" error log.
      case 'focus-session':
        return;

      case 'file-search': {
        const files = this.fileSearch ? await this.fileSearch.search(msg.query) : [];
        this.emit({ t: 'file-search-result', id: msg.id, query: msg.query, files });
        return;
      }
    }
  }

  /**
   * `send` on a session restored from `index.json` (archived: false, but no
   * live AgentSession — see SessionManager.init()) needs `open()` to
   * materialize it. `open()` throws on an unknown/unknown-state SessionId
   * (e.g. an attacker-adjacent id that never existed), so that failure is
   * swallowed here into a no-op rather than letting it propagate — `route()`
   * would otherwise reject for a message that should simply be ignored.
   */
  private async reopen(id: string) {
    try {
      return await this.manager.open(id);
    } catch {
      return undefined;
    }
  }

  /**
   * Reads each ref's content off disk, resolved against `session`'s own cwd
   * — the same tree the mention was searched over, and which multiple
   * sessions in this panel are free to disagree about.
   */
  private resolveFileRefsFor(session: AgentSession, refs: FileRef[]) {
    return resolveFileRefs(refs, async (relativePath) => {
      try {
        return await fs.readFile(path.resolve(session.state.cwd, relativePath), 'utf8');
      } catch {
        return undefined;
      }
    });
  }

  /** One sentence covering whichever kind of ref went missing, or both. */
  private missingMessage(sessionMissing: SessionRef[], fileMissing: FileRef[]): string {
    return [
      sessionMissing.length > 0 ? missingRefsMessage(sessionMissing) : undefined,
      fileMissing.length > 0 ? missingFileRefsMessage(fileMissing) : undefined,
    ].filter((line): line is string => line !== undefined).join(' ');
  }

  private async adopt(session: AgentSession, id: SessionId, paths: string[]): Promise<void> {
    if (!this.attachments) { return; }
    const { attachments, rejected } = await this.attachments.adopt(id, paths);
    const room = MAX_PENDING - session.pendingAttachments.length;
    const accepted = attachments.slice(0, Math.max(0, room));
    if (accepted.length > 0) {
      session.addAttachments(accepted);
      this.emitAttachments(session, id);
    }
    // One message carrying every reason, not one message per reason: two
    // emissions would make the second overwrite the first, and a drop that
    // broke the cap *and* contained a folder has two things to say.
    const reasons = [
      ...rejected.map((r) => `${r.name} — ${r.reason}`),
      ...(attachments.length > accepted.length ? ['A turn can carry up to 10 attachments.'] : []),
    ];
    if (reasons.length > 0) { this.emit({ t: 'attachments-rejected', id, reasons }); }
  }

  private emitAttachments(session: AgentSession, id: SessionId): void {
    this.emit({ t: 'session-attachments', id, attachments: session.pendingAttachments });
  }
}

const KNOWN_MESSAGE_TAGS = new Set<WebviewToHost['t']>([
  'ready', 'create-session', 'set-visible', 'set-layout', 'close-session',
  'delete-session', 'send', 'interrupt', 'cancel-queued',
  'set-effort', 'set-permission-mode',
  'set-model', 'permission-decision', 'question-answer', 'load-more',
  'answer-relocation', 'cancel-relocation', 'fork-session',
  'set-include-context', 'reveal-file',
  'attach-paste', 'attach-pick', 'attach-drop', 'attach-remove', 'attach-failed',
  'request-context', 'open-file',
  'request-bring-back', 'bring-back',
  'request-stale-trees', 'remove-stale-tree',
  'request-fleet-diff', 'open-file-diff', 'open-review', 'open-fleet', 'open-fleet-subagent',
  'focus-session',
  'refresh-catalog', 'open-settings', 'login-provider', 'open-external', 'export-table-csv',
  'file-search', 'set-favorite-models',
]);

/**
 * A minimal shape guard for messages arriving over `webview.postMessage`,
 * which — unlike a same-process call — hands us `unknown` at runtime no
 * matter what `WebviewToHost` claims at compile time. `route()`'s switch
 * dereferences `msg.t` (and, for `set-layout`, `msg.layout.panes` by way of
 * `SessionManager.layout()`/`setLayout()`) unconditionally; a `null` message
 * or a malformed `set-layout` would otherwise either throw before the
 * try/catch even reaches a case (fine, since `handle()` catches it) or —
 * worse — silently store a broken `PaneLayout` that then throws on every
 * future `ready`, permanently breaking hydrate for the life of the
 * extension host. Reject anything malformed here instead of letting it in.
 */
function isWireMessage(msg: unknown): msg is WebviewToHost {
  if (typeof msg !== 'object' || msg === null) { return false; }
  const t = (msg as { t?: unknown }).t;
  if (typeof t !== 'string' || !KNOWN_MESSAGE_TAGS.has(t as WebviewToHost['t'])) {
    return false;
  }
  if (t === 'set-layout') {
    const layout = (msg as { layout?: unknown }).layout;
    if (typeof layout !== 'object' || layout === null) { return false; }
    if (!Array.isArray((layout as { panes?: unknown }).panes)) { return false; }
  }
  return true;
}

import type { SessionManager } from './session-manager';
import type { HostToWebview, SessionSnapshot, WebviewToHost } from '../protocol/messages';

export class MessageRouter {
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
    private readonly defaultCwd: string,
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
      console.error('[hiiiid-code] message-router: failed to handle', msg?.t, err);
    }
  }

  private async route(msg: WebviewToHost): Promise<void> {
    if (!isWireMessage(msg)) {
      console.error('[hiiiid-code] message-router: dropping malformed message', msg);
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
        });
        return;
      }

      case 'create-session': {
        const session = await this.manager.create(
          msg.providerId, msg.cwd || this.defaultCwd, msg.model, msg.effort,
        );
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
        session?.send(msg.text);
        return;
      }

      case 'interrupt':
        await this.manager.get(msg.id)?.interrupt();
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

      case 'permission-decision':
        this.manager.get(msg.id)?.respondToPermission(msg.requestId, msg.decision);
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

      case 'request-usage': {
        const result = await this.manager.usageWindows(msg.providerId);
        this.emit({ t: 'usage-windows', providerId: msg.providerId, result });
        return;
      }

      // PanelViewProvider intercepts this before delegating (it needs the
      // `vscode` API, which this module must not import). It is listed here,
      // and in KNOWN_MESSAGE_TAGS, so a stray one is a deliberate no-op
      // rather than a "malformed message" error log.
      case 'open-file':
        return;
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
}

const KNOWN_MESSAGE_TAGS = new Set<WebviewToHost['t']>([
  'ready', 'create-session', 'set-visible', 'set-layout', 'close-session',
  'delete-session', 'send', 'interrupt', 'set-effort', 'set-permission-mode',
  'set-model', 'permission-decision', 'load-more',
  'request-context', 'request-usage', 'open-file',
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

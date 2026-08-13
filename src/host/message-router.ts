import type { SessionManager } from './session-manager';
import type { HostToWebview, SessionSnapshot, WebviewToHost } from '../protocol/messages';

export class MessageRouter {
  constructor(
    private readonly manager: SessionManager,
    private readonly emit: (msg: HostToWebview) => void,
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
      console.error('[hiiiid-code] message-router: failed to handle', msg.t, err);
    }
  }

  private async route(msg: WebviewToHost): Promise<void> {
    switch (msg.t) {
      case 'ready': {
        const layout = this.manager.layout();
        const snapshots: SessionSnapshot[] = [];
        for (const pane of layout.panes) {
          const session = this.manager.get(pane.sessionId);
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
          msg.providerId, msg.cwd, msg.model, msg.effort,
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

      case 'set-effort':
        this.manager.get(msg.id)?.setEffort(msg.effort);
        return;

      case 'set-permission-mode':
        this.manager.get(msg.id)?.setPermissionMode(msg.mode);
        return;

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

import type { HostToWebview } from '../protocol/messages';

/**
 * One registered surface. `wants` is the whole gate: a client that does not
 * want a message never sees it, so widening the fan-out cannot accidentally
 * widen what a narrow client receives.
 */
export interface PostClient {
  post(msg: HostToWebview): void;
  wants(msg: HostToWebview): boolean;
}

/**
 * What the review tab subscribes to *through this bus*.
 *
 * Deliberately an allow-list, not a deny-list. `session-patch` is gated on the
 * visible set and that gating lives in SessionManager; the review client simply
 * never asks for it, so there is no second place where visibility is decided.
 * A new message type defaults to *not* reaching the review tab, which is the
 * safe direction to fail.
 *
 * This is not the whole story of what the review webview receives, though:
 * `ReviewPanel` also owns its own `MessageRouter`, whose `emit` posts
 * straight to the same webview outside this bus entirely — that is how
 * `hydrate` and `editor-context` actually reach it, each in direct answer to
 * a message this client sent (`ready`). `hydrate` is deliberately not listed
 * here as a result: nothing ever `bus.post`s one — only the router's `emit`
 * does — so listing it would claim a fan-out path that does not exist.
 */
export const REVIEW_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'session-status' || msg.t === 'fleet-diff';

/**
 * The fleet view's allow-list. `session-patch` and `layout-changed` joined
 * 2026-08-30, once Fleet started rendering a session's subagent transcripts
 * rather than just roster status: both are already gated to the sidebar's
 * visible-pane set (`session-patch` by `SessionManager`, `layout-changed`
 * simply by carrying the current `PaneLayout` itself), so admitting them here
 * inherits that scope for free rather than deciding it a second time. Never
 * `fleet-diff` — Fleet has no diff surface — so a new message type still
 * defaults to not reaching this client, the same discipline `REVIEW_WANTS`
 * documents.
 */
export const FLEET_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'sessions-changed' || msg.t === 'session-status'
  || msg.t === 'session-patch' || msg.t === 'layout-changed';

export class PostBus {
  private readonly clients = new Set<PostClient>();

  add(client: PostClient): () => void {
    this.clients.add(client);
    return () => { this.clients.delete(client); };
  }

  /**
   * A disposed webview can throw from `postMessage`. One dead client must not
   * cost the others their message — errors are state, and a fan-out that
   * aborts halfway is a state nobody can reconstruct.
   */
  post(msg: HostToWebview): void {
    for (const client of this.clients) {
      if (!client.wants(msg)) { continue; }
      try {
        client.post(msg);
      } catch (err) {
        console.error('[mar-code] a webview client failed to receive', msg.t, err);
      }
    }
  }
}

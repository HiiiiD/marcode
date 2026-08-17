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
 * What the review tab subscribes to.
 *
 * Deliberately an allow-list, not a deny-list. `session-patch` is gated on the
 * visible set and that gating lives in SessionManager; the review client simply
 * never asks for it, so there is no second place where visibility is decided.
 * A new message type defaults to *not* reaching the review tab, which is the
 * safe direction to fail.
 */
export const REVIEW_WANTS = (msg: HostToWebview): boolean =>
  msg.t === 'hydrate' || msg.t === 'sessions-changed'
  || msg.t === 'session-status' || msg.t === 'fleet-diff';

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
        console.error('[hiiiid-code] a webview client failed to receive', msg.t, err);
      }
    }
  }
}

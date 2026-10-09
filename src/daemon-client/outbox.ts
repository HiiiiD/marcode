import type { WebviewToHost } from '../protocol/messages';

export const OUTBOX_CAP = 50;

type Queued = Extract<WebviewToHost, { t: 'send' | 'set-draft' }>;

/** User input posted during an outage: a prompt or draft the UI already cleared would otherwise be lost. */
export class Outbox {
  private items: Queued[] = [];

  constructor(private readonly cap = OUTBOX_CAP) {}

  offer(msg: WebviewToHost): boolean {
    if (msg.t !== 'send' && msg.t !== 'set-draft') { return false; }
    if (msg.t === 'set-draft') {
      this.items = this.items.filter((m) => m.t !== 'set-draft' || m.id !== msg.id);
    }
    this.items.push(msg);
    if (this.items.length > this.cap) { this.items.splice(0, this.items.length - this.cap); }
    return true;
  }

  drain(): Queued[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  clear(): void { this.items = []; }
}

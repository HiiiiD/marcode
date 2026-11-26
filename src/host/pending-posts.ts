/** Messages for a target that may not exist yet (a sidebar view VS Code has not resolved); held, then flushed in order. */
export class PendingPosts<T> {
  private target: ((msg: T) => void) | undefined;
  private queue: T[] = [];

  post(msg: T): void {
    if (this.target) { this.target(msg); } else { this.queue.push(msg); }
  }

  attach(target: (msg: T) => void): void {
    this.target = target;
    const held = this.queue;
    this.queue = [];
    for (const msg of held) { target(msg); }
  }

  detach(): void {
    this.target = undefined;
  }
}

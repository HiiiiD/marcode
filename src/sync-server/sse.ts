import type { ServerResponse } from 'node:http';

const PING_MS = 25_000;

/** Open event streams, by device, so a revoke can end that device's streams. */
export class EventHub {
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private readonly ping: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly opts: { onPresence?: (deviceId: string, online: boolean) => void } = {}) {
    this.ping = setInterval(() => { this.write(': ping\n\n'); }, PING_MS);
    this.ping.unref();
  }

  open(deviceId: string, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': open\n\n');
    const set = this.streams.get(deviceId) ?? new Set();
    const first = set.size === 0;
    set.add(res);
    this.streams.set(deviceId, set);
    if (first) { this.opts.onPresence?.(deviceId, true); }
    res.on('close', () => {
      if (!set.delete(res) || set.size > 0 || this.closed) { return; }
      if (this.streams.get(deviceId) === set) { this.streams.delete(deviceId); }
      this.opts.onPresence?.(deviceId, false);
    });
  }

  isOnline(deviceId: string): boolean {
    return (this.streams.get(deviceId)?.size ?? 0) > 0;
  }

  emit(event: string, data: unknown, exceptDeviceId?: string): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [deviceId, set] of this.streams) {
      if (deviceId === exceptDeviceId) { continue; }
      for (const res of set) { res.write(frame); }
    }
  }

  closeDevice(deviceId: string): void {
    for (const res of this.streams.get(deviceId) ?? []) { res.end(); }
    this.streams.delete(deviceId);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.ping);
    for (const set of this.streams.values()) { for (const res of set) { res.end(); } }
    this.streams.clear();
  }

  private write(frame: string): void {
    for (const set of this.streams.values()) { for (const res of set) { res.write(frame); } }
  }
}

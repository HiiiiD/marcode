import type { ShellItem, TranscriptItem } from '../../protocol/messages';
import { resolveShellCommand, type ShellAliasTable } from './shell-aliases';
import { shellContextBlock, undeliveredShells } from './shell-context';
import { runShell, type ShellRunHandle } from './shell-runner';

export interface ShellHost {
  cwd(): string;
  aliases(): ShellAliasTable;
  nextId(): string;
  append(item: ShellItem): void;
  replace(item: ShellItem): void;
  refuse(message: string): void;
}

export class ShellController {
  private current: { item: ShellItem; handle: ShellRunHandle } | undefined;
  private undelivered: ShellItem[] = [];
  private disposed = false;

  constructor(private readonly host: ShellHost, private readonly run: typeof runShell = runShell) {}

  isRunning(itemId: string): boolean { return this.current?.item.id === itemId; }

  start(command: string): void {
    if (this.disposed) { return; }
    if (this.current) { this.host.refuse('A shell command is already running in this session.'); return; }
    const item: ShellItem = {
      id: this.host.nextId(), ts: Date.now(), role: 'shell', command, state: 'running', output: '',
    };
    this.host.append(item);
    this.undelivered.push(item);
    const handle = this.run(
      { cwd: this.host.cwd(), spec: resolveShellCommand(command, this.host.aliases()) },
      (output, truncated) => this.update({ output, ...(truncated ? { truncated } : {}) }),
    );
    this.current = { item, handle };
    void handle.done.then((result) => {
      this.update({
        state: result.cancelled ? 'cancelled' : 'done',
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      this.current = undefined;
    });
  }

  cancel(itemId: string): void {
    if (this.current?.item.id === itemId) { this.current.handle.cancel(); }
  }

  prime(items: TranscriptItem[]): void {
    const known = new Set(this.undelivered.map((i) => i.id));
    this.undelivered = [...undeliveredShells(items).filter((i) => !known.has(i.id)), ...this.undelivered];
  }

  takeBlock(): string {
    const block = shellContextBlock(this.undelivered);
    this.undelivered = [];
    return block;
  }

  dispose(): void {
    if (!this.current) { return; }
    const { handle } = this.current;
    this.update({ state: 'cancelled', error: 'interrupted' });
    this.disposed = true;
    this.current = undefined;
    handle.cancel();
  }

  private update(patch: Partial<ShellItem>): void {
    if (this.disposed || !this.current) { return; }
    const next = { ...this.current.item, ...patch } as ShellItem;
    this.current.item = next;
    this.undelivered = this.undelivered.map((i) => (i.id === next.id ? next : i));
    this.host.replace(next);
  }
}

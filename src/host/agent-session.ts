import type {
  AgentEvent, AgentProvider, AgentRun, EffortLevel, PermissionMode, ToolDecision,
} from '../providers/types';
import type {
  PermissionRequest, SessionId, SessionSnapshot, SessionState, SessionStatus,
  TranscriptItem, TranscriptPatch,
} from '../protocol/messages';
import type { TranscriptStore } from './transcript-store';

export interface SessionSink {
  patch(id: SessionId, patch: TranscriptPatch): void;
  status(id: SessionId, status: SessionStatus): void;
  changed(): void;
}

const TITLE_MAX = 60;
let counter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
}

export class AgentSession {
  private run: AgentRun;
  private pending = new Map<string, PermissionRequest>();
  private openAssistantId: string | undefined;
  private toolItems = new Map<string, TranscriptItem>();
  private permissionItems = new Map<string, TranscriptItem>();
  private pumping: Promise<void>;
  private disposed = false;
  /**
   * TranscriptStore.flush() is not safe to call concurrently for the same
   * session id — two overlapping calls can both observe the same pending
   * queue before either clears it, duplicating writes. We only ever flush
   * this session, so chain every flush onto the previous one to serialize.
   * This chain never rejects (see scheduleFlush): a rejected link here
   * would otherwise surface as an unhandled rejection at the fire-and-forget
   * call sites, or reject out of dispose()/snapshot() for no actionable
   * reason.
   */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly _state: SessionState,
    private readonly provider: AgentProvider,
    private readonly store: TranscriptStore,
    private readonly sink: SessionSink,
  ) {
    this.run = provider.start({
      cwd: _state.cwd,
      model: _state.model,
      effort: _state.effort,
      permissionMode: _state.permissionMode,
      resumeToken: _state.resumeToken,
    });
    this.pumping = this.pump();
  }

  get state(): SessionState { return this._state; }

  send(text: string): void {
    if (this._state.title === 'Untitled' && text.trim().length > 0) {
      this._state.title = text.trim().slice(0, TITLE_MAX);
    }
    const item: TranscriptItem = { id: nextId('u'), ts: Date.now(), role: 'user', text };
    this.appendItem(item);
    this.closeAssistant();
    this.setStatus('running');
    try {
      this.run.send(text);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.run.interrupt();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  setEffort(effort: EffortLevel): void {
    this._state.effort = effort;
    this._state.updatedAt = Date.now();
    try {
      this.run.setEffort(effort);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.sink.changed();
  }

  setPermissionMode(mode: PermissionMode): void {
    this._state.permissionMode = mode;
    this._state.updatedAt = Date.now();
    try {
      this.run.setPermissionMode(mode);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.sink.changed();
  }

  respondToPermission(requestId: string, decision: ToolDecision): void {
    if (!this.pending.delete(requestId)) { return; }
    try {
      this.run.respondToTool(requestId, decision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The provider rejected the decision, so the request is no longer
      // outstanding as far as it's concerned. Settle the persisted item as
      // denied (rather than leaving it 'pending' forever with no way for
      // the user to retry, since `pending` no longer has this requestId).
      const existing = this.permissionItems.get(requestId);
      if (existing && existing.role === 'permission') {
        const settled: TranscriptItem = { ...existing, state: 'denied', reason: message };
        this.replaceItem(settled);
        this.permissionItems.set(requestId, settled);
      }
      this.fail(message);
      return;
    }

    const existing = this.permissionItems.get(requestId);
    if (existing && existing.role === 'permission') {
      const settled: TranscriptItem = {
        ...existing,
        state: decision.allow ? 'allowed' : 'denied',
        reason: decision.allow ? undefined : decision.reason,
      };
      this.replaceItem(settled);
      this.permissionItems.set(requestId, settled);
    }
    this.setStatus(this.pending.size > 0 ? 'awaiting-approval' : 'running');
  }

  async snapshot(): Promise<SessionSnapshot> {
    await this.scheduleFlush();
    const { items, hasMore } = await this.store.tail(this._state.id);
    return { ...this._state, items, hasMore, pending: [...this.pending.values()] };
  }

  async loadMore(beforeItemId: string) {
    return this.store.before(this._state.id, beforeItemId);
  }

  async dispose(): Promise<void> {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const requestId of [...this.pending.keys()]) {
      this.pending.delete(requestId);
      try {
        this.run.respondToTool(requestId, { allow: false, reason: 'Session closed' });
      } catch {
        // Best-effort: the provider is being torn down regardless.
      }
    }
    try {
      await this.run.dispose();
    } catch {
      // Best-effort: nothing left to report a failure into once disposed.
    }
    await this.pumping;
    await this.scheduleFlush();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.run.events) { this.handle(event); }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private handle(event: AgentEvent): void {
    switch (event.kind) {
      case 'session':
        this._state.resumeToken = event.resumeToken;
        this.sink.changed();
        return;

      case 'text':
      case 'thinking': {
        const field = event.kind === 'text' ? 'text' : 'thinking';
        if (!this.openAssistantId) {
          const item: TranscriptItem = {
            id: nextId('a'), ts: Date.now(), role: 'assistant', text: '',
          };
          this.openAssistantId = item.id;
          this.appendItem(item);
        }
        this.mergeDelta(this.openAssistantId, field, event.delta);
        return;
      }

      case 'tool-start': {
        const item: TranscriptItem = {
          id: nextId('t'), ts: Date.now(), role: 'tool',
          toolId: event.id, name: event.name, input: event.input, state: 'running',
        };
        this.toolItems.set(event.id, item);
        this.closeAssistant();
        this.appendItem(item);
        return;
      }

      case 'tool-end': {
        const existing = this.toolItems.get(event.id);
        if (!existing || existing.role !== 'tool') { return; }
        const settled: TranscriptItem = {
          ...existing, state: event.ok ? 'ok' : 'error', output: event.output,
        };
        this.toolItems.set(event.id, settled);
        this.replaceItem(settled);
        return;
      }

      case 'permission': {
        const item: TranscriptItem = {
          id: nextId('p'), ts: Date.now(), role: 'permission',
          requestId: event.id, name: event.name, input: event.input, state: 'pending',
        };
        this.permissionItems.set(event.id, item);
        this.pending.set(event.id, {
          requestId: event.id, name: event.name, input: event.input,
        });
        this.closeAssistant();
        this.appendItem(item);
        this.setStatus('awaiting-approval');
        return;
      }

      case 'usage':
        this._state.usage = {
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
        };
        this.sink.changed();
        return;

      case 'turn-end':
        this.closeAssistant();
        if (event.reason === 'error') {
          this.fail(event.error ?? 'Agent run failed');
        } else {
          this.setStatus('idle');
          void this.scheduleFlush();
        }
        return;
    }
  }

  private fail(message: string): void {
    this.appendItem({ id: nextId('e'), ts: Date.now(), role: 'error', message });
    this.setStatus('error');
    void this.scheduleFlush();
  }

  /**
   * Serializes calls into TranscriptStore.flush(), which is not safe to
   * overlap. Always resolves — a flush failure is swallowed here rather
   * than rejecting, so it can never become an unhandled rejection at a
   * fire-and-forget call site and can never reject out of dispose()/
   * snapshot() for the caller.
   */
  private scheduleFlush(): Promise<void> {
    this.flushChain = this.flushChain
      .then(
        () => this.store.flush(this._state.id),
        () => this.store.flush(this._state.id),
      )
      .catch(() => { /* swallowed: see flushChain doc comment above */ });
    return this.flushChain;
  }

  private appendItem(item: TranscriptItem): void {
    this.store.append(this._state.id, item);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'append', item });
  }

  private replaceItem(item: TranscriptItem): void {
    this.store.replace(this._state.id, item);
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'replace', item });
  }

  private pendingAssistant: { text?: string; thinking?: string } | undefined;

  /** Accumulates streamed deltas into the open assistant item. */
  private mergeDelta(itemId: string, field: 'text' | 'thinking', delta: string): void {
    const current = this.pendingAssistant ?? {};
    current[field] = (current[field] ?? '') + delta;
    this.pendingAssistant = current;
    this.store.replace(this._state.id, {
      id: itemId, ts: Date.now(), role: 'assistant',
      text: current.text ?? '', thinking: current.thinking,
    });
    this._state.updatedAt = Date.now();
    this.sink.patch(this._state.id, { op: 'delta', itemId, field, delta });
  }

  /** Ends the current assistant item so the next delta starts a new one. */
  private closeAssistant(): void {
    this.openAssistantId = undefined;
    this.pendingAssistant = undefined;
  }

  private setStatus(status: SessionStatus): void {
    if (this._state.status === status) { return; }
    this._state.status = status;
    this._state.updatedAt = Date.now();
    this.sink.status(this._state.id, status);
    this.sink.changed();
  }
}

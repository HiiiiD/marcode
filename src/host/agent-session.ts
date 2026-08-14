import type {
  AgentEvent, AgentProvider, AgentRun, EffortLevel, PermissionMode, ToolDecision,
} from '../providers/types';
import type {
  McpServerStatus, PermissionRequest, SessionId, SessionSnapshot, SessionState,
  SessionStatus, TranscriptItem, TranscriptPatch,
} from '../protocol/messages';
import type { TranscriptStore } from './transcript-store';
import { parseToolName } from './mcp-tool-name';

export interface SessionSink {
  patch(id: SessionId, patch: TranscriptPatch): void;
  status(id: SessionId, status: SessionStatus): void;
  mcp(id: SessionId, servers: McpServerStatus[]): void;
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
  /** Provider tool id -> the buffered children of that (parent) tool call. */
  private childrenByParent = new Map<string, TranscriptItem[]>();
  /** Provider tool id of a child -> the provider tool id of its parent. */
  private childOf = new Map<string, string>();
  /** Permission request id -> the provider tool id of the subagent it nests under. */
  private permissionChildOf = new Map<string, string>();
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
  /**
   * Live provider state only — never persisted, never on SessionState.
   * An archived session reports none, because there is no run to ask.
   */
  private mcpServers: McpServerStatus[] = [];

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

  /**
   * Records the choice as state either way — even after the first message,
   * once the SDK can no longer honor it live — the same as the other
   * setters. Whether it takes effect is a provider concern (see
   * AgentRun.setModel); this method has no way to tell the difference
   * between "took effect" and "recorded, ignored by the running query", and
   * doesn't need to: the UI itself disables the control once a change would
   * be a no-op.
   */
  setModel(model: string): void {
    this._state.model = model;
    this._state.updatedAt = Date.now();
    try {
      this.run.setModel(model);
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.sink.changed();
  }

  /**
   * Always goes through the live run.setPermissionMode() seam, in either
   * direction — including into and out of 'bypass'. ClaudeProvider itself
   * decides whether that means updating a not-yet-constructed session's
   * pending options or calling the SDK's live Query.setPermissionMode,
   * depending on whether this session's first message has been sent yet;
   * AgentSession does not need to know which.
   */
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
        const parentRoot = this.permissionChildOf.get(requestId);
        if (parentRoot) { this.replaceChild(parentRoot, settled); }
        else { this.replaceItem(settled); }
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
      const parentRoot = this.permissionChildOf.get(requestId);
      if (parentRoot) { this.replaceChild(parentRoot, settled); }
      else { this.replaceItem(settled); }
      this.permissionItems.set(requestId, settled);
    }
    this.setStatus(this.pending.size > 0 ? 'awaiting-approval' : 'running');
  }

  async snapshot(): Promise<SessionSnapshot> {
    await this.scheduleFlush();
    const { items, hasMore } = await this.store.tail(this._state.id);
    return {
      ...this._state, items, hasMore,
      pending: [...this.pending.values()],
      mcpServers: this.mcpServers,
    };
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
        const parsed = parseToolName(event.name);
        const item: TranscriptItem = {
          id: nextId('t'), ts: Date.now(), role: 'tool',
          toolId: event.id, name: parsed.name, input: event.input, state: 'running',
          ...(parsed.mcpServer ? { mcpServer: parsed.mcpServer } : {}),
        };
        this.toolItems.set(event.id, item);

        const parentItemId = event.parentId
          ? this.parentItemIdFor(event.parentId)
          : undefined;
        if (event.parentId && parentItemId) {
          const root = this.resolveParent(event.parentId);
          this.childOf.set(event.id, root);
          const children = this.childrenByParent.get(root) ?? [];
          children.push(item);
          this.childrenByParent.set(root, children);
          // Deliberately no closeAssistant() here: a subagent's tool
          // activity interleaves with the parent's prose, and splitting the
          // open assistant item on every child would shred one reply into
          // a dozen bubbles.
          this.sink.patch(this._state.id, { op: 'append', item, parentItemId });
          this._state.updatedAt = Date.now();
          return;
        }

        this.closeAssistant();
        this.appendItem(item);
        return;
      }

      case 'tool-end': {
        const existing = this.toolItems.get(event.id);
        if (!existing || existing.role !== 'tool') { return; }
        const children = this.childrenByParent.get(event.id);
        const settled: TranscriptItem = {
          ...existing,
          state: event.ok ? 'ok' : 'error',
          output: event.output,
          ...(children ? { children: [...children] } : {}),
        };
        this.toolItems.set(event.id, settled);

        const parentRoot = this.childOf.get(event.id);
        if (parentRoot) {
          this.replaceChild(parentRoot, settled);
          return;
        }
        this.childrenByParent.delete(event.id);
        this.replaceItem(settled);
        return;
      }

      case 'permission': {
        // The permission id is the tool-use id of the call being approved,
        // so a permission raised inside a subagent resolves through the
        // same child map its tool-start populated. Providers that report a
        // parent explicitly are honoured first.
        const parentSource = event.parentId ?? this.childOf.get(event.id);
        const parentItemId = parentSource
          ? this.parentItemIdFor(parentSource)
          : undefined;

        const item: TranscriptItem = {
          id: nextId('p'), ts: Date.now(), role: 'permission',
          requestId: event.id, name: parseToolName(event.name).name,
          input: event.input, state: 'pending',
        };
        this.permissionItems.set(event.id, item);
        this.pending.set(event.id, {
          requestId: event.id, name: event.name, input: event.input,
        });

        if (parentSource && parentItemId) {
          const root = this.resolveParent(parentSource);
          const children = this.childrenByParent.get(root) ?? [];
          children.push(item);
          this.childrenByParent.set(root, children);
          this.permissionChildOf.set(event.id, root);
          this.sink.patch(this._state.id, { op: 'append', item, parentItemId });
          this._state.updatedAt = Date.now();
        } else {
          this.closeAssistant();
          this.appendItem(item);
        }
        this.setStatus('awaiting-approval');
        return;
      }

      case 'usage':
        this._state.usage = {
          inputTokens: event.inputTokens, outputTokens: event.outputTokens,
        };
        this.sink.changed();
        return;

      case 'mcp-servers':
        // Replace-whole, not a merge: the provider always sends the full
        // array, so hydrate and live update are the same code path.
        this.mcpServers = event.servers;
        this.sink.mcp(this._state.id, event.servers);
        return;

      case 'turn-end':
        this.closeAssistant();
        this.flushUnsettledParents();
        if (event.reason === 'error') {
          this.fail(event.error ?? 'Agent run failed');
        } else {
          // A permission raised earlier in the same event batch (e.g. inside
          // a subagent) can still be outstanding when turn-end arrives —
          // unconditionally going idle here would strand its card as the
          // only sign anything is waiting, with the status dot claiming
          // otherwise.
          this.setStatus(this.pending.size > 0 ? 'awaiting-approval' : 'idle');
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

  /**
   * Resolves a reported parent to the top-level tool call it belongs under.
   *
   * Claude subagents cannot spawn subagents, so a reported grandchild means
   * a provider we did not anticipate. Walking up to the nearest depth-1
   * ancestor flattens it rather than growing the data model into a tree.
   * The iteration cap keeps a malformed cycle from hanging the pump.
   */
  private resolveParent(parentId: string): string {
    let current = parentId;
    for (let hops = 0; hops < 8; hops++) {
      const next = this.childOf.get(current);
      if (next === undefined) { return current; }
      current = next;
    }
    return current;
  }

  /** The transcript item id of a resolved parent, if we ever saw its tool-start. */
  private parentItemIdFor(parentId: string): string | undefined {
    const root = this.resolveParent(parentId);
    const item = this.toolItems.get(root);
    return item && item.role === 'tool' ? item.id : undefined;
  }

  /**
   * Settles an item that lives inside a parent's children buffer.
   *
   * While the parent tool call is still running, its children are not in
   * the store yet — they land there inline when the parent settles — so
   * this just updates the buffer and streams a patch, with no store write.
   *
   * But `flushUnsettledParents` can have already settled the parent (e.g.
   * an interrupt mid-subagent) and cleared the buffer, while a permission
   * raised inside it is still outstanding and answered later. In that case
   * the parent's persisted `children` array is the only durable copy, so
   * this rebuilds the parent item with the child updated in place and
   * writes it through `replaceItem` — one store write and one patch that
   * swaps the whole parent, children included.
   */
  private replaceChild(parentRoot: string, item: TranscriptItem): void {
    const buffered = this.childrenByParent.get(parentRoot);
    if (buffered) {
      const at = buffered.findIndex((c) => c.id === item.id);
      if (at >= 0) { buffered[at] = item; } else { buffered.push(item); }
      const parentItemId = this.parentItemIdFor(parentRoot);
      this._state.updatedAt = Date.now();
      this.sink.patch(this._state.id, { op: 'replace', item, parentItemId });
      return;
    }

    const parent = this.toolItems.get(parentRoot);
    if (!parent || parent.role !== 'tool') { return; }
    const existingChildren = parent.children ?? [];
    const at = existingChildren.findIndex((c) => c.id === item.id);
    const children = at >= 0
      ? existingChildren.map((c, i) => (i === at ? item : c))
      : [...existingChildren, item];
    const settledParent: TranscriptItem = { ...parent, children };
    this.toolItems.set(parentRoot, settledParent);
    this.replaceItem(settledParent);
  }

  /**
   * Settles any parent tool call still running when the turn ended.
   *
   * Interrupt, provider crash, or a turn ending mid-Task means the parent's
   * `tool-end` never arrives, so its buffered children would be dropped on
   * the floor — discarding, on disk, subagent work the user watched happen
   * on screen.
   */
  private flushUnsettledParents(): void {
    for (const [parentId, children] of this.childrenByParent) {
      const existing = this.toolItems.get(parentId);
      if (!existing || existing.role !== 'tool' || existing.state !== 'running') { continue; }
      const settled: TranscriptItem = {
        ...existing, state: 'error', children: [...children],
      };
      this.toolItems.set(parentId, settled);
      this.replaceItem(settled);
    }
    this.childrenByParent.clear();
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

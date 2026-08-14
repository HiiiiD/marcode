import { toEditorContext, type EditorSnapshot } from './editor-context';
import type { EditorContext } from '../providers/types';

export interface Disposable { dispose(): void }

/**
 * Where editor state comes from. `src/host/vscode-editor-source.ts` is the
 * real implementation; tests pass a fake, which is the whole reason this
 * interface exists — nothing here may import `vscode`.
 */
export interface EditorSource {
  /** Fires with the active editor, or null when there is none. */
  onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void): Disposable;
  onDidCloseDocument(cb: (fsPath: string) => void): Disposable;
  workspaceRoots(): string[];
}

/**
 * Holds the editor context that a message will carry.
 *
 * The load-bearing behavior: `vscode.window.activeTextEditor` goes
 * `undefined` while the panel webview holds focus, and the user must focus
 * the composer to type. A live read at send time would therefore return
 * nothing exactly when it matters. So `null` and non-file editors are
 * treated as "no news" and the last valid value is kept. Only closing the
 * tracked document clears it.
 */
export class EditorContextTracker {
  private _current: EditorContext | null = null;
  private trackedPath: string | null = null;
  private readonly listeners = new Set<(ctx: EditorContext | null) => void>();
  private readonly subs: Disposable[] = [];
  private disposed = false;

  constructor(private readonly source: EditorSource) {
    this.subs.push(source.onDidChangeEditor((snap) => this.observe(snap)));
    this.subs.push(source.onDidCloseDocument((fsPath) => this.onClose(fsPath)));
  }

  get current(): EditorContext | null { return this._current; }

  onChange(cb: (ctx: EditorContext | null) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const sub of this.subs) { sub.dispose(); }
    this.subs.length = 0;
    this.listeners.clear();
  }

  private observe(snap: EditorSnapshot | null): void {
    if (this.disposed || !snap) { return; }
    const next = toEditorContext(snap, this.source.workspaceRoots());
    if (!next) { return; }
    this.trackedPath = snap.fsPath;
    this.set(next);
  }

  private onClose(fsPath: string): void {
    if (this.disposed || this.trackedPath !== fsPath) { return; }
    this.trackedPath = null;
    this.set(null);
  }

  /**
   * Structural equality via JSON: a bare cursor move produces a byte-identical
   * file-reference context, and selection events fire on every keystroke.
   * Without this the webview would be re-rendered for no visible change.
   */
  private set(next: EditorContext | null): void {
    if (JSON.stringify(next) === JSON.stringify(this._current)) { return; }
    this._current = next;
    for (const cb of this.listeners) { cb(next); }
  }
}

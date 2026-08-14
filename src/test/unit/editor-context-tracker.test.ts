import * as assert from 'assert';
import * as path from 'path';
import { EditorContextTracker, type EditorSource } from '../../host/editor-context-tracker';
import type { EditorSnapshot } from '../../host/editor-context';
import type { EditorContext } from '../../providers/types';

const ROOT = path.resolve('/work/repo');

class FakeSource implements EditorSource {
  private editorCbs = new Set<(snap: EditorSnapshot | null) => void>();
  private closeCbs = new Set<(fsPath: string) => void>();

  onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void) {
    this.editorCbs.add(cb);
    return { dispose: () => { this.editorCbs.delete(cb); } };
  }

  onDidCloseDocument(cb: (fsPath: string) => void) {
    this.closeCbs.add(cb);
    return { dispose: () => { this.closeCbs.delete(cb); } };
  }

  workspaceRoots(): string[] { return [ROOT]; }

  emitEditor(snap: EditorSnapshot | null): void { for (const cb of this.editorCbs) { cb(snap); } }
  emitClose(fsPath: string): void { for (const cb of this.closeCbs) { cb(fsPath); } }

  /** Live subscriber count, so a test can prove the subscription was actually
   * released — not merely that an internal flag swallowed the callback. */
  get subscriberCount(): number { return this.editorCbs.size + this.closeCbs.size; }
}

function snap(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    fsPath: path.join(ROOT, 'src', 'a.ts'),
    scheme: 'file',
    languageId: 'typescript',
    ranges: [],
    ...over,
  };
}

suite('EditorContextTracker', () => {
  let source: FakeSource;
  let tracker: EditorContextTracker;
  let seen: (EditorContext | null)[];

  setup(() => {
    source = new FakeSource();
    tracker = new EditorContextTracker(source);
    seen = [];
    tracker.onChange((ctx) => seen.push(ctx));
  });

  teardown(() => { tracker.dispose(); });

  test('starts empty', () => {
    assert.strictEqual(tracker.current, null);
  });

  test('a file editor becomes the current context', () => {
    source.emitEditor(snap());
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
    assert.strictEqual(seen.length, 1);
  });

  test('losing the active editor keeps the last context', () => {
    source.emitEditor(snap());
    // This is what the panel webview taking focus looks like: VS Code reports
    // activeTextEditor as undefined. Dropping the context here would break the
    // feature exactly when the user is typing into the composer.
    source.emitEditor(null);
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
    assert.strictEqual(seen.length, 1);
  });

  test('a non-file editor is ignored rather than clearing', () => {
    source.emitEditor(snap());
    source.emitEditor(snap({ scheme: 'output', fsPath: 'extension-output' }));
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
    assert.strictEqual(seen.length, 1);
  });

  test('an identical snapshot does not re-notify', () => {
    source.emitEditor(snap());
    source.emitEditor(snap());
    assert.strictEqual(seen.length, 1);
  });

  test('a selection change notifies with the new ranges', () => {
    source.emitEditor(snap());
    source.emitEditor(snap({ ranges: [{ startLine: 3, endLine: 4, text: 'hi' }] }));
    assert.strictEqual(seen.length, 2);
    assert.deepStrictEqual(tracker.current?.selection?.ranges, [
      { startLine: 3, endLine: 4, text: 'hi' },
    ]);
  });

  test('closing the tracked document clears the context', () => {
    source.emitEditor(snap());
    source.emitClose(path.join(ROOT, 'src', 'a.ts'));
    assert.strictEqual(tracker.current, null);
    assert.deepStrictEqual(seen[seen.length - 1], null);
  });

  test('closing an unrelated document leaves the context alone', () => {
    source.emitEditor(snap());
    source.emitClose(path.join(ROOT, 'src', 'other.ts'));
    assert.strictEqual(tracker.current?.path, 'src/a.ts');
  });

  test('dispose stops delivery', () => {
    tracker.dispose();
    source.emitEditor(snap());
    assert.strictEqual(seen.length, 0);
  });

  test('dispose releases the underlying subscriptions', () => {
    assert.strictEqual(source.subscriberCount, 2);
    tracker.dispose();
    assert.strictEqual(source.subscriberCount, 0);
    source.emitEditor(snap());
    assert.strictEqual(seen.length, 0);
  });
});

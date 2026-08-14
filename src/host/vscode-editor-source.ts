import * as vscode from 'vscode';
import type { EditorSnapshot } from './editor-context';
import type { Disposable, EditorSource } from './editor-context-tracker';

/**
 * The real `EditorSource`. The 0-based-to-1-based line conversion happens
 * here and nowhere else: everything above this boundary speaks the numbers
 * the editor gutter shows.
 */
export function createVscodeEditorSource(): EditorSource & { dispose(): void } {
  // Each entry disposes exactly once, however it is reached: through the
  // per-subscription Disposable returned to a caller, or through this
  // source's own aggregate dispose(). Guarding here means the two can race
  // or run in either order without a double-dispose of the underlying
  // vscode.Disposable.
  const subs = new Set<Disposable>();

  const track = (real: vscode.Disposable): Disposable => {
    let done = false;
    const guarded: Disposable = {
      dispose: () => {
        if (done) { return; }
        done = true;
        subs.delete(guarded);
        real.dispose();
      },
    };
    subs.add(guarded);
    return guarded;
  };

  return {
    onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void): Disposable {
      const emit = (editor: vscode.TextEditor | undefined) => {
        cb(editor ? snapshot(editor) : null);
      };
      const local = [
        track(vscode.window.onDidChangeActiveTextEditor(emit)),
        track(vscode.window.onDidChangeTextEditorSelection((e) => emit(e.textEditor))),
      ];
      // Seed from whatever is already open at activation, so the first
      // message of a session carries context without the user touching
      // anything.
      emit(vscode.window.activeTextEditor);
      return { dispose: () => { for (const sub of local) { sub.dispose(); } } };
    },

    onDidCloseDocument(cb: (fsPath: string) => void): Disposable {
      const local = [track(vscode.workspace.onDidCloseTextDocument((doc) => cb(doc.uri.fsPath)))];
      return { dispose: () => { for (const sub of local) { sub.dispose(); } } };
    },

    workspaceRoots(): string[] {
      return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    },

    dispose(): void {
      for (const sub of [...subs]) { sub.dispose(); }
    },
  };
}

function snapshot(editor: vscode.TextEditor): EditorSnapshot {
  return {
    fsPath: editor.document.uri.fsPath,
    scheme: editor.document.uri.scheme,
    languageId: editor.document.languageId,
    ranges: editor.selections
      .filter((sel) => !sel.isEmpty)
      .map((sel) => ({
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text: editor.document.getText(sel),
      })),
  };
}

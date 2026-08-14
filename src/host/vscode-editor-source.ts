import * as vscode from 'vscode';
import type { EditorSnapshot } from './editor-context';
import type { Disposable, EditorSource } from './editor-context-tracker';

/**
 * The real `EditorSource`. The 0-based-to-1-based line conversion happens
 * here and nowhere else: everything above this boundary speaks the numbers
 * the editor gutter shows.
 */
export function createVscodeEditorSource(): EditorSource & { dispose(): void } {
  const subs: vscode.Disposable[] = [];

  return {
    onDidChangeEditor(cb: (snap: EditorSnapshot | null) => void): Disposable {
      const emit = (editor: vscode.TextEditor | undefined) => {
        cb(editor ? snapshot(editor) : null);
      };
      subs.push(vscode.window.onDidChangeActiveTextEditor(emit));
      subs.push(vscode.window.onDidChangeTextEditorSelection((e) => emit(e.textEditor)));
      // Seed from whatever is already open at activation, so the first
      // message of a session carries context without the user touching
      // anything.
      emit(vscode.window.activeTextEditor);
      return { dispose: () => { /* all subs released by dispose() below */ } };
    },

    onDidCloseDocument(cb: (fsPath: string) => void): Disposable {
      subs.push(vscode.workspace.onDidCloseTextDocument((doc) => cb(doc.uri.fsPath)));
      return { dispose: () => { /* all subs released by dispose() below */ } };
    },

    workspaceRoots(): string[] {
      return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    },

    dispose(): void {
      for (const sub of subs) { sub.dispose(); }
      subs.length = 0;
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

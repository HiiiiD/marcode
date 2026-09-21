import * as vscode from 'vscode';
import type { SessionManager } from './session-manager';
import type { SessionId } from '../protocol/messages';
// `pane-layout.ts` and `layout-tree.ts` import nothing (no `vscode`, DOM or
// React), so pulling them into the CJS host bundle is safe.
import { appendAtTop } from '../webview/components/pane-layout';
import { leafSessionIds } from '../webview/components/layout-tree';

/** Adds a session to the sidebar's split if absent, then reveals the sidebar. */
export async function focusSession(manager: SessionManager, id: SessionId): Promise<void> {
  const ids = leafSessionIds(manager.layout().root);
  if (!ids.includes(id)) {
    await manager.setVisible([...ids, id]);
    manager.setLayout({ ...manager.layout(), root: appendAtTop(manager.layout().root, id) });
  }
  await vscode.commands.executeCommand('workbench.view.extension.mar-code');
}

import * as vscode from 'vscode';
import type { SessionManager } from './session-manager';
import type { SessionId } from '../protocol/messages';
// `pane-layout.ts` and `layout-tree.ts` import nothing (no `vscode`, DOM or
// React), so pulling them into the CJS host bundle is safe.
import { leafSessionIds, placeSession, rootOrientation } from '../webview/components/layout-tree';

/** Adds a session to the sidebar's split if absent, then reveals the sidebar. */
export async function focusSession(manager: SessionManager, id: SessionId): Promise<void> {
  const ids = leafSessionIds(manager.layout().root);
  if (!ids.includes(id)) {
    await manager.setVisible([...ids, id]);
    const { root, focusedSessionId } = manager.layout();
    manager.setLayout({ ...manager.layout(), root: placeSession(root, id, focusedSessionId, rootOrientation(root)) });
  }
  await vscode.commands.executeCommand('workbench.view.extension.mar-code');
}

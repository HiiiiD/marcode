import type { SessionManager } from './session-manager';
import type { SessionId } from '../protocol/messages';
// `layout-tree.ts` imports nothing (no `vscode`, DOM or React), so pulling it into the CJS host bundle is safe.
import { leafSessionIds, placeSession, rootOrientation } from '../webview/components/layout-tree';

/** Adds a session to the split if absent. Revealing the sidebar is the client's job. */
export async function focusSession(manager: SessionManager, id: SessionId): Promise<void> {
  const ids = leafSessionIds(manager.layout().root);
  if (ids.includes(id)) { return; }
  await manager.setVisible([...ids, id]);
  const { root, focusedSessionId } = manager.layout();
  manager.setLayout({ ...manager.layout(), root: placeSession(root, id, focusedSessionId, rootOrientation(root)) });
}

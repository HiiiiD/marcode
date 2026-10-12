import type { SessionManager } from './session-manager';
import type { SessionId } from '../protocol/messages';
// `layout-tree.ts` imports nothing (no `vscode`, DOM or React), so pulling it into the CJS host bundle is safe.
import { placeSessionAuto, type AutoGridOptions } from '../client-core/auto-grid';
import { leafSessionIds, rootOrientation } from '../webview/components/layout-tree';

const NO_AUTO: AutoGridOptions = { enabled: false, viewport: { width: 0, height: 0 }, minPane: { width: 0, height: 0 } };

/**
 * Adds a session to the split if absent. Revealing the sidebar is the client's job.
 * `auto` is passed only for agent-spawned sessions; a user-initiated reveal keeps the old placement.
 */
export async function focusSession(manager: SessionManager, id: SessionId, auto?: AutoGridOptions): Promise<void> {
  const ids = leafSessionIds(manager.layout().root);
  if (ids.includes(id)) { return; }
  await manager.setVisible([...ids, id]);
  const { root, focusedSessionId } = manager.layout();
  const placed = placeSessionAuto(root, id, focusedSessionId, rootOrientation(root), auto ?? { ...NO_AUTO });
  manager.setLayout({ ...manager.layout(), root: placed.root });
  if (placed.offerRearrange) { manager.offerRearrange(); }
}

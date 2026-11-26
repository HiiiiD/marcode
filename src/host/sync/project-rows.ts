import * as path from 'node:path';
import type { SyncProjectView } from '../../protocol/messages';
import { normalizeWorkspacePath } from '../../shared/workspace-dir';
import type { ProjectOverride } from '../host-config';
import type { ProjectRef } from '../project/project-resolver';

const samePath = (a: string, b: string): boolean => normalizeWorkspacePath(a) === normalizeWorkspacePath(b);

export async function projectRows(
  roots: string[], overrides: ProjectOverride[], resolve: (cwd: string) => Promise<ProjectRef | undefined>,
): Promise<SyncProjectView[]> {
  return Promise.all(roots.map(async (root): Promise<SyncProjectView> => {
    const ref = await resolve(root).catch(() => undefined);
    const override = overrides.find((o) => samePath(o.path, root));
    const choice = override ? (override.project === 'own' ? 'own' : 'linked') : ref ? 'shared' : 'none';
    return { path: root, name: path.basename(root), ...(ref ? { projectId: ref.projectId } : {}), choice };
  }));
}

export function applyProjectChoice(
  overrides: ProjectOverride[], root: string, choice: 'shared' | 'own' | { link: string },
): ProjectOverride[] {
  const rest = overrides.filter((o) => !samePath(o.path, root));
  if (choice === 'shared') { return rest; }
  return [...rest, { path: root, project: choice === 'own' ? 'own' : choice.link }];
}

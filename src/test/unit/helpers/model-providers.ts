import type { AgentProvider, ModelInfo } from '../../../providers/types';

/**
 * A provider whose model list is only correct after `fetchModels` — the
 * shape of every real backend, where the catalog lives in the CLI.
 */
export function modelProvider(
  id: string, onFetch?: () => Promise<never>, loginKind?: 'oauth' | 'none',
): AgentProvider {
  let models: ModelInfo[] = [{ id: 'stale', displayName: 'Stale' }];
  return {
    id, displayName: id, threadScope: 'cwd',
    ...(loginKind ? { loginKind } : {}),
    listModels: () => models,
    listPermissionModes: () => [],
    fetchModels: async (cwd: string) => {
      if (onFetch) { await onFetch(); }
      models = [{ id: `fresh-${cwd}`, displayName: 'Fresh' }];
      return models;
    },
    start: () => { throw new Error('not used'); },
  };
}

/** A provider that can offer nothing until — and unless — a probe succeeds. */
export function unavailableProvider(id: string, reason: string, loginKind?: 'oauth' | 'none'): AgentProvider {
  return {
    id, displayName: id, threadScope: 'cwd',
    ...(loginKind ? { loginKind } : {}),
    listModels: () => [],
    listPermissionModes: () => [],
    fetchModels: () => Promise.reject(new Error(reason)),
    start: () => { throw new Error('not used'); },
  };
}

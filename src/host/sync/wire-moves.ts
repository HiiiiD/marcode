import type { AgentProvider } from '../../providers/types';
import type { SyncCredentials } from '../../sync/credentials';
import { ownerKey } from '../../sync/owner-key';
import { SyncClient } from '../../sync/sync-client';
import type { SyncState } from '../../sync/sync-state';
import type { ProjectResolver } from '../project/project-resolver';
import type { SessionManager } from '../session-manager';
import { MoveResponder } from './move-responder';
import { MoveService } from './move-service';
import { RemoteSessions } from './remote-sessions';
import type { SessionPublisher } from './session-publisher';
import { ThreadPublisher } from './thread-publisher';

/** Everything a paired host needs to see other devices' sessions and move them: built once, in `createHost`. */
export function wireMoves(deps: {
  manager: SessionManager; stores: { state: SyncState; mirrorRoot: string }; creds: SyncCredentials; home: string;
  sessions: SessionPublisher; providers: Map<string, AgentProvider>; projects: ProjectResolver; roots: () => string[];
  excluded: string[]; takeOverAfterMinutes: number; pollMs?: number;
}): { dispose(): void } {
  const { manager, stores, creds } = deps;
  const publishable = (id: string) => manager.publishableSession(id);
  manager.setRemoteSessions(new RemoteSessions({
    root: stores.mirrorRoot, windowProjects: () => manager.windowProjects(), tailIntervalMs: deps.pollMs,
    owners: { key: (id) => ownerKey(creds, id), self: { deviceId: creds.deviceId, deviceName: creds.deviceName }, sync: stores.state },
  }));
  const threads = new ThreadPublisher({ state: stores.state, providers: deps.providers, publishable, excluded: deps.excluded });
  manager.setTurnListener((id) => { void threads.turnEnded(id); });
  const responder = new MoveResponder({
    manager, state: stores.state, sessions: deps.sessions, threads, mirrorRoot: stores.mirrorRoot, deviceName: creds.deviceName,
    selfDeviceId: creds.deviceId,
    ownerOf: async (id) => {
      const owners = await new SyncClient(creds).owners();
      if (!owners.ok) { throw new Error(owners.error); }
      return owners.value.find((o) => o.key === ownerKey(creds, id));
    },
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  });
  responder.start();
  manager.setMoveService(new MoveService({
    manager, state: stores.state, home: deps.home, mirrorRoot: stores.mirrorRoot, roots: deps.roots, projects: deps.projects,
    takeOverAfterMs: deps.takeOverAfterMinutes * 60_000, ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
  }));
  return { dispose: () => { responder.dispose(); } };
}

import type { SessionManagerLike } from '../self-control-mcp-server';
import type { SpawnPreference } from './spawn-preference';
import type { Caller } from './spawn-support';

export interface ToolDeps {
  sessionManager: SessionManagerLike;
  caller: () => Caller | undefined;
  spawnPreference?: SpawnPreference;
}

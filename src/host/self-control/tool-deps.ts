import type { SessionManagerLike } from '../self-control-mcp-server';
import type { Caller } from './spawn-support';

export interface ToolDeps {
  sessionManager: SessionManagerLike;
  caller: () => Caller | undefined;
}

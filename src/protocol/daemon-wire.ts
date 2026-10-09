import type { HostToWebview, WebviewToHost } from './messages';

export type ClientKind = 'sidebar' | 'review' | 'fleet' | 'history' | 'tui';

export interface LoginRecipeWire {
  id: string;
  terminalName: string;
  command: string;
  /** Only the keys that differ from the daemon's own process.env. */
  env: Record<string, string>;
}

export type RejectReason = 'protocol-mismatch' | 'bad-token' | 'upgrade-busy' | 'bad-hello';

export type ActOp =
  | 'reveal' | 'openDiff' | 'openSettings' | 'openExternal'
  | 'exportCsv' | 'exportImage' | 'login' | 'setFavoriteModels';
export type AskOp = 'pick' | 'search';

export interface DaemonIdentity { protocolVersion: number; appVersion: string }

export type ClientFrame =
  | ({ f: 'hello'; clientKind: ClientKind; token: string; roots: string[]; defaultCwd: string } & DaemonIdentity)
  | { f: 'msg'; m: WebviewToHost }
  | { f: 'ctx'; ctx: unknown }
  | { f: 'res'; id: number; ok: true; result: unknown }
  | { f: 'res'; id: number; ok: false; error: string }
  | { f: 'shutdown'; token: string };

export type ServerFrame =
  | ({ f: 'welcome'; clientId: string; loginRecipes: LoginRecipeWire[] } & DaemonIdentity)
  | { f: 'reject'; reason: RejectReason; daemon: DaemonIdentity }
  | { f: 'msg'; m: HostToWebview }
  | { f: 'act'; op: ActOp; args: unknown[] }
  | { f: 'req'; id: number; op: AskOp; args: unknown[] }
  | { f: 'bye' }
  | { f: 'refuse'; reason: 'busy' | 'bad-token' };

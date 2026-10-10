import type { ClientKind } from '../protocol/daemon-wire';
import type { HostToWebview } from '../protocol/messages';
import { FLEET_WANTS, HISTORY_WANTS, REVIEW_WANTS } from '../host/post-bus';

const ALL = (): boolean => true;

export function wantsFor(kind: ClientKind): (m: HostToWebview) => boolean {
  switch (kind) {
    case 'review': return REVIEW_WANTS;
    case 'fleet': return FLEET_WANTS;
    case 'history': return HISTORY_WANTS;
    default: return ALL;
  }
}

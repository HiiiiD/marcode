import type { SessionId, SessionState } from '../protocol/messages';

type Owner = NonNullable<SessionState['owner']>;

export interface MergeInput {
  ours: Map<SessionId, SessionState>;
  disk: SessionState[];
  owners: Map<SessionId, Owner>;
  knownOnDisk: Set<SessionId>;
}

export interface MergeResult {
  sessions: SessionState[];
  adopt: SessionState[];
  update: SessionState[];
  drop: SessionId[];
  knownOnDisk: Set<SessionId>;
  changed: boolean;
}

function stripOwner(state: SessionState): SessionState {
  const { owner: _owner, ...rest } = state;
  return rest as SessionState;
}

// Key-by-key over the disk copy's keys: our in-memory copy carries local-only fields
// and a different key order, so comparing whole serialized objects would never settle.
function differs(ours: SessionState, disk: SessionState, owner: Owner): boolean {
  const mine = ours as unknown as Record<string, unknown>;
  const theirs = disk as unknown as Record<string, unknown>;
  return Object.keys(theirs).some((k) => JSON.stringify(mine[k]) !== JSON.stringify(theirs[k]))
    || JSON.stringify(ours.owner) !== JSON.stringify(owner);
}

export function mergeRoster(input: MergeInput): MergeResult {
  const { ours, disk, owners, knownOnDisk } = input;
  const onDisk = new Set(disk.map((d) => d.id));
  const sessions: SessionState[] = [];
  const adopt: SessionState[] = [];
  const update: SessionState[] = [];
  const drop: SessionId[] = [];

  for (const d of disk) {
    const owner = owners.get(d.id);
    const mine = ours.get(d.id);
    if (!mine) {
      adopt.push(owner ? { ...d, owner } : d);
      sessions.push(stripOwner(d));
    } else if (owner) {
      if (differs(mine, d, owner)) { update.push({ ...d, owner }); }
      sessions.push(stripOwner(d));
    } else {
      sessions.push(stripOwner(mine));
    }
  }

  for (const [id, mine] of ours) {
    if (onDisk.has(id)) { continue; }
    if (knownOnDisk.has(id)) { drop.push(id); } else { sessions.push(stripOwner(mine)); }
  }

  return {
    sessions, adopt, update, drop,
    knownOnDisk: new Set(sessions.map((x) => x.id)),
    changed: adopt.length > 0 || update.length > 0 || drop.length > 0,
  };
}

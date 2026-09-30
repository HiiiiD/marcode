import type { SessionId, SessionState } from '../protocol/messages';

type Owner = NonNullable<SessionState['owner']>;

export interface MergeInput {
  ours: Map<SessionId, SessionState>;
  disk: SessionState[];
  owners: Map<SessionId, Owner>;
  knownOnDisk: Set<SessionId>;
  /** Ids this host holds the lease for. */
  owned?: Set<SessionId>;
  /** Ids this host deleted; a stale index must not bring them back. */
  tombstones?: Set<SessionId>;
  /** Ids whose JSONL is still on disk. */
  transcripts?: Set<SessionId>;
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

// Nothing runs a session nobody holds a lease on: a 'running' row there is a crashed owner's last word.
function unleased(state: SessionState): SessionState {
  const { owner: _owner, queued: _queued, ...rest } = state;
  return { ...rest, status: 'idle' } as SessionState;
}

// Key-by-key over the disk copy's keys: our in-memory copy carries local-only fields
// and a different key order, so comparing whole serialized objects would never settle.
function differs(ours: SessionState, disk: SessionState, owner: Owner | undefined): boolean {
  const mine = ours as unknown as Record<string, unknown>;
  const theirs = disk as unknown as Record<string, unknown>;
  return Object.keys(theirs).some((k) => JSON.stringify(mine[k]) !== JSON.stringify(theirs[k]))
    || JSON.stringify(ours.owner) !== JSON.stringify(owner);
}

export function mergeRoster(input: MergeInput): MergeResult {
  const { ours, disk, owners, knownOnDisk } = input;
  const owned = input.owned ?? new Set<SessionId>();
  const tombstones = input.tombstones ?? new Set<SessionId>();
  const transcripts = input.transcripts ?? new Set<SessionId>();
  const onDisk = new Set(disk.map((d) => d.id));
  const sessions: SessionState[] = [];
  const adopt: SessionState[] = [];
  const update: SessionState[] = [];
  const drop: SessionId[] = [];

  for (const d of disk) {
    if (tombstones.has(d.id)) { continue; }
    const owner = owners.get(d.id);
    const mine = ours.get(d.id);
    if (!mine) {
      adopt.push(owner ? { ...d, owner } : unleased(d));
      sessions.push(owner ? stripOwner(d) : unleased(d));
    } else if (owner) {
      if (differs(mine, d, owner)) { update.push({ ...d, owner }); }
      sessions.push(stripOwner(d));
    } else if (!owned.has(d.id) && d.updatedAt > mine.updatedAt) {
      const free = unleased(d);
      if (differs(mine, free, undefined)) { update.push(free); }
      sessions.push(free);
    } else {
      sessions.push(stripOwner(mine));
    }
  }

  for (const [id, mine] of ours) {
    if (onDisk.has(id) && !tombstones.has(id)) { continue; }
    const deletedElsewhere = knownOnDisk.has(id) && !owned.has(id) && !transcripts.has(id);
    if (deletedElsewhere) { drop.push(id); } else { sessions.push(stripOwner(mine)); }
  }

  return {
    sessions, adopt, update, drop,
    knownOnDisk: new Set(sessions.map((x) => x.id)),
    changed: adopt.length > 0 || update.length > 0 || drop.length > 0,
  };
}

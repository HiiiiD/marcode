import type { Caller } from './spawn-support';

/** The hosted subagents `me` may talk to: its own children and, when it is one itself, its siblings. */
export function familyOf(all: Caller[], me: Caller): { children: Caller[]; siblings: Caller[] } {
  const hosted = all.filter((s) => s.kind === 'subagent');
  return {
    children: hosted.filter((s) => s.parentId === me.id),
    siblings: me.kind === 'subagent' ? hosted.filter((s) => s.parentId === me.parentId && s.id !== me.id) : [],
  };
}

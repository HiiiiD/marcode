export type SpawnPreference = 'auto' | 'nested' | 'pane';

export const SPAWN_PREFERENCES: readonly SpawnPreference[] = ['auto', 'nested', 'pane'];

/** An explicit `nested` from the model always wins; the setting only supplies the default. */
export function resolveNested(nested: boolean | undefined, preference: SpawnPreference = 'auto'): boolean {
  return nested ?? preference === 'nested';
}

const NEVER_IF_USER_TALKS = 'Never nest a session the user needs to talk to or steer: only a pane has a composer.';

export function nestedDescription(preference: SpawnPreference = 'auto'): string {
  const lead = preference === 'nested'
    ? 'Defaults to `true` here. '
    : preference === 'pane'
      ? 'Defaults to `false` here (own pane). '
      : 'Prefer `true` whenever you are delegating work you will wait on or only need the result of. ';
  return lead + 'Nested: the session runs inside this conversation as one compact card (no pane), its approvals are answered here, '
    + 'it closes when it finishes, and this call returns at once. Its reply arrives as a message that starts your next turn, so you can '
    + 'end your turn and wait, or call marcode__await_subagent. ' + NEVER_IF_USER_TALKS;
}

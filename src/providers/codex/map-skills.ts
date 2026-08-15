import type { Invocable } from '../types';
import type { SkillsListResponse } from './wire';

/**
 * `skills/list`'s response to the panel's `/`-menu entries.
 *
 * Lives in its own module because two callers need it and neither may import
 * the other: `CodexProvider.listInvocables` (the pull) and `CodexRun`'s
 * `skills/changed` handler (the push). `codex-provider.ts` already imports
 * `codex-run.ts`, so the shared half cannot live in either.
 *
 * `skills/list` nests its answer one level deeper than every other list
 * request: `data` is one `SkillsListEntry` per requested cwd, each carrying
 * that cwd's own `skills`, not a flat list. This flattens across entries
 * (only one cwd is ever requested, but the shape allows more), drops any
 * skill the server itself marked `enabled: false` — a disabled skill must not
 * be offered for `/name` invocation — and prefers `shortDescription` over the
 * full `description` for the menu row, since that field exists specifically
 * for compact display. Parsing stays tolerant (missing arrays default to
 * empty) the same way `mapNotification` treats an unrecognized shape as zero
 * results rather than a thrown error.
 */
export function toInvocables(response: SkillsListResponse | undefined): Invocable[] {
  return (response?.data ?? [])
    .flatMap((entry) => entry.skills ?? [])
    // Explicit `false` only: a field this parser doesn't recognize (or a
    // future CLI that drops it entirely — this protocol carries no version)
    // must not silently empty the user's `/`-menu the way a truthy check on
    // a missing value would.
    .filter((skill) => skill.enabled !== false)
    .map((skill) => ({
      name: skill.name,
      description: skill.shortDescription ?? skill.description,
      origin: skill.scope,
    }));
}

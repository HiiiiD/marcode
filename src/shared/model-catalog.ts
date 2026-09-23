import type { EffortLevel, ModelInfo } from '../providers/types';

/**
 * The catalog row covering `id`, or undefined.
 *
 * Not a plain `find` on `id`, because a provider's rows and a session's
 * persisted model are not the same namespace. The Claude CLI reports
 * *selectable* rows, several of which are aliases — `opus` resolves to
 * `claude-opus-5`, `sonnet` to `claude-sonnet-5` — while a session persists
 * whatever id it was created with, which for any session predating the
 * dynamic catalog is the wire id. Matching on `id` alone leaves those
 * sessions with no row: the model picker falls back to rendering the raw id,
 * and the effort control (which hangs off the row) disappears entirely.
 *
 * `resolvedModel` is exactly the reconciliation key the SDK publishes for
 * this, so an alias row claims the wire ids it covers.
 *
 * Shared between the host (session creation resolves a requested model) and
 * the webview (panes render the row's label and effort levels) so the two
 * can never disagree about which row a session is on.
 */
export function findModel(models: ModelInfo[], id: string | undefined): ModelInfo | undefined {
  if (id === undefined) { return undefined; }
  return models.find((m) => m.id === id) ?? models.find((m) => m.resolvedModel === id);
}

/**
 * The key a hidden-models entry names.
 *
 * A model id alone is not unique across providers — two providers can
 * publish the same id (an alias like `opus` is exactly the kind that
 * collides) — so hiding one must not hide the other's row of the same name.
 */
export function modelKey(providerId: string, modelId: string): string {
  return `${providerId} ${modelId}`;
}

/** Whether `providerId`/`modelId` is in `favorites` — see `modelKey` for the join. */
export function isFavorite(providerId: string, modelId: string, favorites: string[]): boolean {
  return favorites.includes(modelKey(providerId, modelId));
}

/**
 * `displayName`, with the resolved version folded in — `Opus` becomes
 * `Opus 5.5`, `Default (recommended)` becomes `Default 5.5 (1M)`.
 *
 * An alias row's `displayName` is the SDK's own label and doesn't move when
 * the alias starts resolving to a new point release, so the picker keeps
 * showing "Opus" across an Opus 5 -> 5.5 bump with nothing distinguishing
 * the two. `resolvedModel` (`claude-opus-5-5[1m]`) is where the real version
 * actually lives — this pulls it back into the label rather than leaving it
 * a click away in a tooltip.
 *
 * Any parenthetical on `displayName` (`(recommended)`, `(1M context)`) is
 * dropped before appending, since the wire id's own bracket suffix
 * (`[1m]` -> `(1M)`) already carries that distinction — keeping both would
 * read as `Opus (1M context) 5.5 (1M)`.
 */
export function expandedDisplayName(model: ModelInfo): string {
  const resolved = model.resolvedModel;
  if (!resolved) { return model.displayName; }

  const bracketMatch = resolved.match(/\[([^\]]+)\]$/);
  const bracket = bracketMatch?.[1];
  const withoutBracket = bracketMatch ? resolved.slice(0, -bracketMatch[0].length) : resolved;

  let rest = withoutBracket.replace(/^claude-/, '');
  const familyMatch = rest.match(/^[a-z]+-/);
  if (familyMatch) { rest = rest.slice(familyMatch[0].length); }
  const version = rest.split('-').filter(Boolean).join('.');
  if (!version) { return model.displayName; }

  const base = model.displayName.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const suffix = bracket ? ` (${bracket.toUpperCase()})` : '';
  return `${base} ${version}${suffix}`;
}

/**
 * `models`, with starred rows moved to the front — a stable partition, so
 * ties (all-starred, none-starred) keep the catalog's own order rather than
 * being re-sorted alphabetically or by id.
 *
 * A reorder, not a filter: this backs the composer's quick-switch, which
 * already has type-to-search for reaching an unstarred row, so nothing here
 * is ever excluded — only decluttered by default. `New session`'s Favorites
 * tab is the one place a favorite list becomes an actual filter, and it
 * builds that directly off `isFavorite` rather than through this function.
 */
export function sortFavoritesFirst(
  models: ModelInfo[], providerId: string, favorites: string[],
): ModelInfo[] {
  if (favorites.length === 0) { return models; }
  const starred: ModelInfo[] = [];
  const rest: ModelInfo[] = [];
  for (const m of models) {
    (isFavorite(providerId, m.id, favorites) ? starred : rest).push(m);
  }
  return [...starred, ...rest];
}

/**
 * The effort a session on `model` should actually be running at, given what
 * it was asking for.
 *
 * Effort is a property of the model, not of the session: a model with no
 * effort control takes none at all, and one that has it only accepts the
 * levels it publishes. Every place a session's model is chosen — creation,
 * and a switch before the first message — has to reconcile the two, or a
 * session ends up carrying an effort its model cannot take (and the composer,
 * which hangs its control off the model row, shows no way to fix it).
 *
 * An absent row means no opinion, not "no effort": a catalog that has not
 * loaded yet, or an id only the backend knows, must not wipe a real choice.
 */
export function resolveEffort(
  model: ModelInfo | undefined, requested: EffortLevel | undefined,
): EffortLevel | undefined {
  if (!model) { return requested; }
  if (!model.effort) { return undefined; }
  return requested && model.effort.levels.includes(requested)
    ? requested
    : model.effort.default;
}

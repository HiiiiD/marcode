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

/**
 * `models`, minus the ones this provider's user asked never to see.
 *
 * Filters by `modelKey`, not bare id, for the same collision reason `findModel`
 * matches `resolvedModel` as a fallback rather than assuming ids are global.
 */
export function visibleModels(
  models: ModelInfo[], providerId: string, hidden: string[],
): ModelInfo[] {
  return models.filter((m) => !hidden.includes(modelKey(providerId, m.id)));
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

import type { ModelInfo } from '../providers/types';

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

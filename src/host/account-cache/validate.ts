import type { ModelInfo, UsageWindow } from '../../providers/types';

/**
 * Narrows a parsed `usage.json` into something `SessionManager.init()` can
 * consume without throwing. `init()` does exactly two things with this
 * value: `Object.entries(usage.providers)`, and, per provider,
 * `windows.map((w) => [w.id, w])` to build a `Map` keyed on `w.id`. Every
 * check below exists to make one of those two calls safe on *any* file
 * content, and no further: `providers` must be a non-null object (so
 * `Object.entries` cannot throw and cannot iterate a string's characters);
 * each provider's value must be an array (so `.map()` exists); and each
 * element of that array must be a non-null object with a string `id` (so
 * `w.id` can be read and used as a Map key without throwing on `null`,
 * `42`, or an object with no `id`). `resetsAt` is deliberately NOT checked
 * past that: a malformed value there is display corruption the strip
 * already renders safely — `Ring` guards with `Number.isFinite`, and a
 * non-number `resetsAt` simply fails the `> now` comparison and is dropped —
 * not a crash, so validating it would make this a schema validator rather
 * than a throw-guard. `label` and `usedPercent` do NOT get that pass: both
 * are rendered directly as React children in `usage-strip.tsx`, and React
 * throws on an object or array child, which would take down the whole
 * panel rather than just misrender one chip. So those two are checked here
 * too — a string `label`, a numeric `usedPercent` — for the same reason as
 * `id`: to keep the two calls above safe, this time by keeping what they
 * hand to React safe rather than what they hand to `Map`/`Object.entries`.
 * A provider whose value fails the array check, or an individual window
 * that fails the element check, is dropped rather than failing the whole
 * file — one corrupt provider or window does not blank out its siblings.
 */
export function validUsageProviders(parsed: unknown): Record<string, UsageWindow[]> {
  if (typeof parsed !== 'object' || parsed === null) { return {}; }
  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== 'object' || providers === null) { return {}; }
  const out: Record<string, UsageWindow[]> = {};
  for (const [providerId, windows] of Object.entries(providers)) {
    if (!Array.isArray(windows)) { continue; }
    out[providerId] = windows.filter(isUsageWindow);
  }
  return out;
}

/**
 * Narrows a parsed `catalog.json` the same way, and for the same reason, as
 * `validUsageProviders` does for usage: `SessionManager.init()` must not throw on
 * any file content, and this one additionally feeds a *picker*.
 *
 * A row survives only if it has the two fields that make it usable at all —
 * `id`, which `findModel` matches on and `create()` resolves, and
 * `displayName`, which the model Select renders. A row without either would
 * sit in the menu as a blank, unselectable line. `resolvedModel` and `effort`
 * are deliberately NOT checked past that: a malformed `effort` costs the
 * effort slider its levels (`resolveEffort` reads through `?.` and simply
 * finds nothing), which is degraded display over a working switcher, not a
 * crash — the same line `isUsageWindow` draws at `resetsAt`.
 */
export function validCatalogProviders(parsed: unknown): Record<string, ModelInfo[]> {
  if (typeof parsed !== 'object' || parsed === null) { return {}; }
  const providers = (parsed as { providers?: unknown }).providers;
  if (typeof providers !== 'object' || providers === null) { return {}; }
  const out: Record<string, ModelInfo[]> = {};
  for (const [providerId, models] of Object.entries(providers)) {
    if (!Array.isArray(models)) { continue; }
    const usable = models.filter(isModelInfo);
    // An empty list is not a seed — it is exactly what "this provider
    // answered nothing" looks like, and writing it into the catalog would
    // put a provider there with no models, which `catalog()` filters out
    // anyway. Drop the key so the shape matches what was actually usable.
    if (usable.length > 0) { out[providerId] = usable; }
  }
  return out;
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { displayName?: unknown }).displayName === 'string'
  );
}

function isUsageWindow(value: unknown): value is UsageWindow {
  return (
    typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { label?: unknown }).label === 'string'
    && typeof (value as { usedPercent?: unknown }).usedPercent === 'number'
  );
}

export function validWindows(parsed: unknown): UsageWindow[] | undefined {
  return Array.isArray(parsed) ? parsed.filter(isUsageWindow) : undefined;
}

export function validModels(parsed: unknown): ModelInfo[] {
  return Array.isArray(parsed) ? parsed.filter(isModelInfo) : [];
}

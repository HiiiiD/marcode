// Pure formatting helpers for ToolCard, kept dependency-free (no React/UI
// imports) so they can be required directly in the Node/mocha unit-test
// harness without pulling in Base UI or DOM-touching component code.

const UNSERIALIZABLE = '<unserializable>';

/**
 * Renders a short one-line preview of arbitrary tool input. `JSON.stringify`
 * can throw (circular structures, `BigInt`) or return `undefined` (a
 * top-level function or symbol), and this runs during render on payloads we
 * don't control — so it must never throw.
 *
 * `budget` defaults to 44 chars, what fits at ~300px — the width this panel
 * usually has — not the 80-char budget a desktop-width column would afford.
 */
export function summarize(input: unknown, budget = 44): string {
  if (input === null || input === undefined) { return ''; }
  if (typeof input === 'string') { return input; }
  let text: string;
  try {
    const json = JSON.stringify(input);
    text = json === undefined ? UNSERIALIZABLE : json;
  } catch {
    text = UNSERIALIZABLE;
  }
  return text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
}

/** Pretty-printed JSON with the same unserializable-safe fallback as summarize. */
export function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? UNSERIALIZABLE : json;
  } catch {
    return UNSERIALIZABLE;
  }
}

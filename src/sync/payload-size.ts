export const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** Cuts every string in `value` to `max` characters, so one huge field cannot push a record over its cap. */
export function trimStrings(value: unknown, max: number): unknown {
  if (typeof value === 'string') { return value.length > max ? `${value.slice(0, max)}…` : value; }
  if (Array.isArray(value)) { return value.map((v) => trimStrings(v, max)); }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimStrings(v, max)]));
  }
  return value;
}

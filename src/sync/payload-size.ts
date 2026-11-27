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

// What identifies an item or says what it is; cutting one would turn an update into a different item.
const IDENTITY_KEYS = new Set(['id', 'role', 'kind', 'type', 'status', 'state', 'op']);

/** Like `trimStrings`, and also keeps only the first `maxItems` of every array; identity fields are left whole. */
export function trimDeep(value: unknown, maxString: number, maxItems: number): unknown {
  if (typeof value === 'string') { return value.length > maxString ? `${value.slice(0, maxString)}…` : value; }
  if (Array.isArray(value)) { return value.slice(0, maxItems).map((v) => trimDeep(v, maxString, maxItems)); }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, IDENTITY_KEYS.has(k) && typeof v === 'string' ? v : trimDeep(v, maxString, maxItems)]));
  }
  return value;
}

import type { AgentProvider, Invocable } from '../providers/types';

/**
 * A catalog belongs to a working directory, not a session: skills resolve
 * from the filesystem and the user's config, so two sessions on the same repo
 * see the same list. The provider id is part of the key because two providers
 * in the same directory are two different catalogs.
 *
 * '\u0000' as the separator: it cannot appear in a path or a provider id, so
 * no pair of inputs can collide by concatenation.
 */
export function catalogKey(providerId: string, cwd: string): string {
  return `${providerId}\u0000${cwd}`;
}

export class CatalogService {
  private readonly cache = new Map<string, Invocable[]>();
  private readonly inflight = new Set<string>();

  /**
   * @param onEntries Called whenever a key acquires or replaces its catalog.
   *   The manager fans this out to every session sharing the key.
   */
  constructor(private readonly onEntries: (key: string, entries: Invocable[]) => void) {}

  get(key: string): Invocable[] | undefined {
    return this.cache.get(key);
  }

  /** Records a catalog learned from a live session's `invocables` event. */
  set(key: string, entries: Invocable[]): void {
    this.cache.set(key, entries);
    this.onEntries(key, entries);
  }

  /**
   * Probes this key's catalog unless it is already known or in flight.
   * Fire-and-forget by design: no caller waits on a catalog, and a session
   * must never be delayed by one.
   */
  ensure(key: string, provider: AgentProvider, cwd: string): void {
    if (this.cache.has(key) || this.inflight.has(key)) { return; }
    if (!provider.listInvocables) { return; }

    this.inflight.add(key);
    void provider.listInvocables(cwd)
      .then((entries) => {
        // A live `commands_changed` event can land — and call `set()` —
        // while this probe is still in flight. That event is always fresher
        // than a probe that started before it, so once the key is cached the
        // probe's own answer must not overwrite it.
        if (this.cache.has(key)) { return; }
        this.set(key, entries);
      })
      .catch((err) => {
        // Errors are state, never exceptions — and here the state is simply
        // "no catalog". Nothing is cached, so the next session created on
        // this cwd retries. A catalog that will not load leaves the composer
        // as plain text; there is nothing the user could act on. Still worth
        // a developer-facing trace, since otherwise a permanently broken CLI
        // is silent.
        console.warn('[mar-code] catalog-service: probe failed for', key, err);
      })
      .finally(() => { this.inflight.delete(key); });
  }
}

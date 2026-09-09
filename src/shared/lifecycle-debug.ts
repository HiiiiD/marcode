/**
 * Opt-in diagnostics for agent turn lifecycle investigations.
 *
 * Keep the payload deliberately narrow: callers should pass state metadata,
 * never prompts, tool inputs, tool outputs, or raw provider messages.
 */
let enabled = false;

export function setLifecycleDebug(next: boolean): void {
  enabled = next;
}

export function lifecycleDebug(scope: string, metadata: Record<string, unknown>): void {
  if (!enabled) { return; }
  console.warn(`[marcode:lifecycle] ${scope}`, metadata);
}

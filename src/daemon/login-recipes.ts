import type { LoginRecipe } from '../host/create-host';
import type { LoginRecipeWire } from '../protocol/daemon-wire';

/** Only the env keys that differ from the daemon's own, so the whole environment never crosses the socket. */
export function toLoginRecipesWire(
  recipes: ReadonlyMap<string, LoginRecipe>, base: NodeJS.ProcessEnv = process.env,
): LoginRecipeWire[] {
  return [...recipes].map(([id, r]) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.env)) {
      if (v !== undefined && base[k] !== v) { env[k] = v; }
    }
    return { id, terminalName: r.terminalName, command: r.command, env };
  });
}

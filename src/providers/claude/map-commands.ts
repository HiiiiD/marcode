// SDK surface verified against @anthropic-ai/claude-agent-sdk@0.3.228 on
// 2026-08-13 by reading node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
//
//   type SlashCommand = {
//     name: string;          // no leading slash
//     description: string;
//     argumentHint: string;  // may be ''
//     aliases?: string[];
//   };
//
// Skills and slash commands arrive in ONE list with no discriminator, which
// is why `Invocable` has no `kind`. `aliases` is deliberately ignored: the
// spec defers it rather than doubling the menu with entries that do the same
// thing.
//
// Input is typed `unknown` on purpose. It arrives either from a control
// response or from a `system` message off the wire; nothing here should throw
// on a shape the installed SDK version does not actually produce.
import type { Invocable } from '../types';

export function toInvocables(commands: unknown): Invocable[] {
  if (!Array.isArray(commands)) { return []; }

  const out: Invocable[] = [];
  for (const raw of commands) {
    if (typeof raw !== 'object' || raw === null) { continue; }
    const { name, description, argumentHint } = raw as {
      name?: unknown; description?: unknown; argumentHint?: unknown;
    };
    if (typeof name !== 'string' || name.length === 0) { continue; }

    const entry: Invocable = { name };
    if (typeof description === 'string' && description.length > 0) {
      entry.description = description;
    }
    // '' is the SDK's "no hint", and ghost text must be absent rather than
    // an empty span the composer still has to clear.
    if (typeof argumentHint === 'string' && argumentHint.length > 0) {
      entry.argHint = argumentHint;
    }
    const origin = originOf(name);
    if (origin) { entry.origin = origin; }
    out.push(entry);
  }
  return out;
}

/**
 * `superpowers:brainstorming` -> `superpowers`. Only the first colon splits,
 * and a leading colon is not an origin (there is no prefix before it). The
 * name itself is never rewritten — it is what gets inserted into the composer.
 */
function originOf(name: string): string | undefined {
  const at = name.indexOf(':');
  return at > 0 ? name.slice(0, at) : undefined;
}

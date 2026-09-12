/**
 * Per-provider custom system prompts, configured via `marcode.systemPrompts`.
 * Pure — no `vscode` import — same reasoning as `provider-instances.ts`.
 *
 * OpenCode has no wire-level hook for a per-session system prompt override
 * (verified against its ACP session/new and prompt-assembly source, not just
 * its docs — `ACP.Service.newSession` -> `session.create` takes only
 * `{id, cwd, mcpServers, model, variant, modeId}`, and `session/system.ts`'s
 * prompt builder takes only `model`/`agent`). A setting key for it would
 * claim support that does not exist, so an opencode-kind id is always
 * dropped, with a warning explaining why — not silently ignored.
 */

import type { ProviderInstanceKind } from './provider-instances';

/** A Claude id may use the CLI's own default prompt, optionally extended. */
export interface ClaudeCodePreset {
  preset: 'claude_code';
  append?: string;
}

/** Claude accepts either form; Codex (via `base_instructions`) only a string. */
export type SystemPromptValue = string | ClaudeCodePreset;

export interface SystemPromptValidation {
  prompts: Record<string, SystemPromptValue>;
  warnings: string[];
}

function isClaudeCodePreset(value: Record<string, unknown>): boolean {
  if (value.preset !== 'claude_code') { return false; }
  return value.append === undefined || typeof value.append === 'string';
}

/**
 * Parses and validates the raw `marcode.systemPrompts` setting value.
 *
 * `kindOf` maps every id this window knows about (base provider ids plus
 * `marcode.providerInstances` ids) to its kind — the same map
 * `computeLoginKind`'s callers already assemble downstream, given here
 * rather than re-derived so this module stays independent of how the caller
 * built its provider list.
 */
export function validateSystemPrompts(
  configured: unknown,
  kindOf: Record<string, ProviderInstanceKind>,
): SystemPromptValidation {
  const prompts: Record<string, SystemPromptValue> = {};
  const warnings: string[] = [];
  if (configured === undefined) { return { prompts, warnings }; }
  if (typeof configured !== 'object' || configured === null || Array.isArray(configured)) {
    warnings.push('marcode.systemPrompts is not an object; ignoring it.');
    return { prompts, warnings };
  }
  for (const [id, value] of Object.entries(configured as Record<string, unknown>)) {
    const kind = kindOf[id];
    if (kind === undefined) {
      warnings.push(`marcode.systemPrompts["${id}"]: unknown provider id; skipping it.`);
      continue;
    }
    if (kind === 'opencode') {
      warnings.push(
        `marcode.systemPrompts["${id}"]: OpenCode has no system-prompt override; skipping it.`,
      );
      continue;
    }
    if (typeof value === 'string') {
      if (value === '') {
        warnings.push(`marcode.systemPrompts["${id}"] is an empty string; skipping it.`);
        continue;
      }
      prompts[id] = value;
      continue;
    }
    if (kind === 'codex') {
      warnings.push(
        `marcode.systemPrompts["${id}"]: Codex only accepts a plain string; skipping it.`,
      );
      continue;
    }
    if (typeof value === 'object' && value !== null && isClaudeCodePreset(value as Record<string, unknown>)) {
      const preset = value as Record<string, unknown>;
      prompts[id] = preset.append !== undefined
        ? { preset: 'claude_code', append: preset.append as string }
        : { preset: 'claude_code' };
      continue;
    }
    warnings.push(
      `marcode.systemPrompts["${id}"] is neither a string nor {"preset":"claude_code"}; skipping it.`,
    );
  }
  return { prompts, warnings };
}

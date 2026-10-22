import type { McpServerSpec } from '../../protocol/messages';

const NAME = /^[A-Za-z0-9_-]+$/;

/** A user-readable reason the spec can't be saved, or undefined when it can. */
export function validateSpec(spec: McpServerSpec, takenInTarget: string[]): string | undefined {
  const name = spec.name.trim();
  if (name === '') { return 'Give the server a name.'; }
  if (!NAME.test(name)) { return 'Names can use letters, digits, - and _ only.'; }
  if (takenInTarget.includes(name)) { return `A server named ${name} already exists there.`; }
  if (spec.transport === 'stdio') {
    return spec.command.trim() === '' ? 'Enter the command that starts the server.' : undefined;
  }
  return /^https?:\/\/\S+$/.test(spec.url.trim()) ? undefined : 'The URL must start with http:// or https://.';
}

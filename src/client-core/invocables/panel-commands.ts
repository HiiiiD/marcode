import type { Invocable } from '../../protocol/messages';

/** Commands the panel answers itself, listed in the `/` menu so they can be found. */
const PANEL_COMMANDS: Invocable[] = [
  { name: 'mcp', description: "Manage this session's MCP servers", bare: true },
];

/**
 * Appended, and only once the provider has sent its own list: an absent list
 * means no menu at all, and a panel entry must not be what opens one. A
 * provider's command of the same name is replaced — its argument hint would
 * promise subcommands the panel never sends to the agent.
 */
export function withPanelCommands(entries: Invocable[] | undefined): Invocable[] {
  if (entries === undefined) { return []; }
  const ours = new Set(PANEL_COMMANDS.map((c) => c.name));
  return [...entries.filter((e) => !ours.has(e.name)), ...PANEL_COMMANDS];
}

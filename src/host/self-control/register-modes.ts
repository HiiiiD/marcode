import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PermissionModeInfo } from '../../providers/types';
import { defaultPermissionMode } from '../../shared/permission-catalog';
import { modeRowsForProvider } from '../../shared/permission-modes';
import type { ToolDeps } from './tool-deps';

export function registerModesTool(mcp: McpServer, { sessionManager }: ToolDeps): void {
  mcp.registerTool(
    'marcode__list_modes',
    {
      title: 'List permission modes per provider',
      description: 'Marcode-specific: lists, per provider, the permission mode ids marcode__spawn_session and '
        + 'marcode__spawn_collaborators accept as `mode`, each with its label and what it does, and the '
        + '`default` mode a session gets when `mode` is omitted and nothing is inherited. Ids are '
        + 'provider-specific (OpenCode\'s "build" is the id `default`); pass the id, never the label. '
        + '`bypass` is listed but needs the user\'s approval to spawn with. Optional `provider` restricts to one provider.',
      inputSchema: z.object({
        provider: z.string().optional().describe('A provider id from this window\'s catalog.'),
      }),
    },
    async ({ provider }) => {
      let entries = sessionManager.catalog();
      if (provider !== undefined) {
        entries = entries.filter((p) => p.id === provider);
        if (entries.length === 0) {
          return { isError: true, content: [{ type: 'text' as const, text: `Unknown or unavailable provider: ${provider}` }] };
        }
      }
      const listed = entries.map((p) => {
        const declared = p.permissionModes as PermissionModeInfo[];
        return {
          provider: p.id,
          default: defaultPermissionMode(declared),
          modes: modeRowsForProvider(p.id, declared).map((m) => ({ id: m.value, label: m.label, description: m.description })),
        };
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(listed) }] };
    },
  );
}

import type { AgentEvent } from '../types';
import type { RequestId } from './app-server';
import type { McpServerElicitationRequestResponse } from './wire';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function elicitationApprovalOf(
  id: RequestId, params: unknown,
): Extract<AgentEvent, { kind: 'permission' }> | undefined {
  const p = record(params);
  if (!p || p.mode !== 'form' || typeof p.serverName !== 'string'
    || !p.serverName.trim() || typeof p.message !== 'string' || !p.message.trim()) {
    return undefined;
  }
  const schema = record(p.requestedSchema);
  const properties = record(schema?.properties);
  // Codex's MCP tool approvals are empty forms; data-entry forms need typed answers.
  if (schema?.type !== 'object' || !properties || Object.keys(properties).length !== 0
    || (schema.required !== undefined
      && (!Array.isArray(schema.required) || schema.required.length !== 0))) {
    return undefined;
  }
  return {
    kind: 'permission', id: String(id),
    tool: {
      kind: 'other', label: 'MCP permission',
      fields: [{ label: 'server', value: p.serverName }], raw: params,
    },
    meta: { description: p.message },
  };
}

export function elicitationResponse(allow: boolean): McpServerElicitationRequestResponse {
  return { action: allow ? 'accept' : 'decline', content: allow ? {} : null, _meta: null };
}

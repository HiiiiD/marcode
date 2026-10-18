import type { ContextBreakdown } from '../types';
import { toContextBreakdown } from '../acp/map-updates';

interface AssistantUsage {
  role: string;
  providerID?: string;
  modelID?: string;
  time?: { created: number };
  tokens?: { input: number; cache: { read: number; write: number } };
}

interface ContextSdk {
  session: {
    messages(params: { sessionID: string; directory: string }, options: { throwOnError: true; signal: AbortSignal }):
      Promise<{ data?: { info: AssistantUsage }[] }>;
  };
  provider: {
    list(params: { directory: string }, options: { throwOnError: true; signal: AbortSignal }):
      Promise<{ data?: { all: { id: string; models: Record<string, { limit: { context: number } }> }[] } }>;
  };
}

export async function readOpenCodeContext(
  sdk: ContextSdk, sessionID: string, directory: string,
): Promise<ContextBreakdown> {
  const options = { throwOnError: true as const, signal: AbortSignal.timeout(4000) };
  const messages = await sdk.session.messages({ sessionID, directory }, options);
  // A new, in-flight assistant message has zero usage until its model call finishes.
  const latest = messages.data?.map(({ info }) => info)
    .filter((info) => info.role === 'assistant' && info.tokens
      && info.tokens.input + info.tokens.cache.read + info.tokens.cache.write > 0)
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0];
  if (!latest?.tokens || !latest.providerID || !latest.modelID) {
    throw new Error('Context usage is not available yet: no model call has reported usage');
  }
  const providers = await sdk.provider.list({ directory }, options);
  const size = providers.data?.all.find(({ id }) => id === latest.providerID)?.models[latest.modelID]?.limit.context;
  if (!size || !Number.isFinite(size) || size <= 0) {
    throw new Error('OpenCode did not report this model’s context-window limit');
  }
  // Match OpenCode's ACP contextTokens: cached input counts, generated output does not.
  const used = latest.tokens.input + latest.tokens.cache.read + latest.tokens.cache.write;
  if (!Number.isFinite(used)) { throw new Error('OpenCode reported invalid context usage'); }
  return toContextBreakdown({ used, size });
}

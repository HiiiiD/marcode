import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionId, SessionState } from '../../protocol/messages';
import type { AgentProvider } from '../../providers/types';
import { threadKey } from '../../shared/thread-key';
import { isShareableProject } from '../../sync/memory-records';
import { chunkFile } from '../../sync/move-records';
import type { SyncState } from '../../sync/sync-state';

export interface ThreadPublisherDeps {
  state: SyncState;
  providers: Map<string, AgentProvider>;
  publishable: (id: SessionId) => SessionState | undefined;
  excluded: string[];
}

/**
 * Uploads a session's native agent thread at every turn end, so a take over finds it even when the owner
 * died. Only the bytes past the last upload go up, unless the file shrank (a rewrite): then a new generation.
 */
export class ThreadPublisher {
  private readonly chains = new Map<SessionId, Promise<unknown>>();

  constructor(private readonly deps: ThreadPublisherDeps) {}

  turnEnded(id: SessionId): Promise<{ generation: number; bytes: number } | undefined> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(() => this.upload(id)).catch((err: unknown) => {
      console.error('[mar-code] sync: could not upload the agent thread of', id, err);
      return undefined;
    });
    this.chains.set(id, next);
    void next.then(() => { if (this.chains.get(id) === next) { this.chains.delete(id); } });
    return next;
  }

  async attachments(id: SessionId, files: Array<{ attachmentId: string; name: string; mime: string; path: string }>): Promise<void> {
    for (const file of files) {
      try {
        const bytes = await fs.readFile(file.path);
        const meta = { type: 'attachment' as const, sessionId: id, attachmentId: file.attachmentId, name: file.name, mime: file.mime, generation: 1 };
        for (const chunk of chunkFile(meta, bytes, 0)) { this.deps.state.enqueue(chunk); }
      } catch (err) {
        console.error('[mar-code] sync: could not upload attachment', file.attachmentId, err);
      }
    }
  }

  private async upload(id: SessionId): Promise<{ generation: number; bytes: number } | undefined> {
    const state = this.deps.publishable(id);
    if (!state || !isShareableProject(state.projectId, this.deps.excluded)) { return undefined; }
    const provider = this.deps.providers.get(state.providerId);
    const token = provider && state.resumeTokens[threadKey(provider.id, provider.threadScope, state.cwd)];
    if (!provider?.threadFiles || !token) { return undefined; }
    let result: { generation: number; bytes: number } | undefined;
    for (const file of await provider.threadFiles({ resumeToken: token, cwd: state.cwd })) {
      const name = path.basename(file);
      const bytes = await fs.readFile(file);
      const prior = this.deps.state.threadOffset(id, name);
      const rewritten = !prior || bytes.length < prior.offset;
      const generation = rewritten ? (prior?.generation ?? 0) + 1 : prior.generation;
      const from = rewritten ? 0 : prior.offset;
      for (const chunk of chunkFile({ type: 'thread-chunk', sessionId: id, providerId: provider.id, name, generation }, bytes, from)) {
        this.deps.state.enqueue(chunk);
      }
      this.deps.state.setThreadOffset(id, name, { generation, offset: bytes.length });
      result = { generation, bytes: bytes.length };
    }
    return result;
  }
}

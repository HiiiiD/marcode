import * as path from 'node:path';
import type { SessionState, TranscriptItem } from '../../protocol/messages';
import type { AgentProvider } from '../../providers/types';
import { threadKey } from '../../shared/thread-key';
import { buildSeed } from '../replay';
import { TranscriptStore } from '../transcript-store';
import { mirrorStoreDir, readAttachments, readThread } from './remote-roster';
import { rewriteThreadPaths } from './thread-paths';

/** The source checkout's root: the session's cwd with its checkout-relative tail taken off, in the source's own separators. */
export function sourceRoot(cwd: string, relCwd: string): { root: string; sep: '/' | '\\' } {
  const sep = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd) ? '\\' : '/';
  if (relCwd === '.' || relCwd === '') { return { root: cwd, sep }; }
  const parts = cwd.split(/[\\/]/);
  return { root: parts.slice(0, parts.length - relCwd.split('/').length).join(sep), sep };
}

/** A mirrored session rebuilt for this device: cwd under `root`, the native thread imported, or a seed to restart from. */
export async function materialize(input: { row: SessionState; root: string; mirrorRoot: string; provider: AgentProvider | undefined }): Promise<{
  state: SessionState; items: TranscriptItem[]; seed?: string; thread: 'restored' | 'restarted';
  attachments: Map<string, { name: string; bytes: Buffer }>;
}> {
  const { row, root, provider } = input;
  const remote = row.remote!;
  const cwd = remote.relCwd === '.' ? root : path.join(root, ...remote.relCwd.split('/'));
  const { items } = await new TranscriptStore(mirrorStoreDir(input.mirrorRoot, remote.deviceId)).tail(row.id, Number.MAX_SAFE_INTEGER);
  const { remote: _remote, ...rest } = row;
  const base = { ...rest, cwd, status: 'idle' as const, updatedAt: Date.now() };
  const token = provider ? row.resumeTokens[threadKey(provider.id, provider.threadScope, row.cwd)] : undefined;
  const files = await readThread(input.mirrorRoot, remote.deviceId, row.id);
  const attachments = await readAttachments(input.mirrorRoot, remote.deviceId, row.id);
  if (provider?.importThread && token && files) {
    const from = sourceRoot(row.cwd, remote.relCwd);
    const to = { root, sep: path.sep as '/' | '\\' };
    const imported = await provider.importThread({
      resumeToken: token, cwd, files: files.map((f) => ({ name: f.name, text: rewriteThreadPaths(f.bytes.toString('utf8'), from, to) })),
    }).catch(() => false as const);
    if (imported) {
      return { state: { ...base, resumeTokens: { [threadKey(provider.id, provider.threadScope, cwd)]: imported.resumeToken } }, items, thread: 'restored', attachments };
    }
  }
  return { state: { ...base, resumeTokens: {} }, items, seed: buildSeed(items, undefined, cwd), thread: 'restarted', attachments };
}

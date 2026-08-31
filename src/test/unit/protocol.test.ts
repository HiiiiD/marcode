import * as assert from 'assert';
import type {
  HostToWebview, ProviderInfo, SessionId, StaleTree, TranscriptItem, UnavailableProvider,
  WebviewToHost,
} from '../../protocol/messages';

function assertNever(x: never): never {
  throw new Error(`unhandled: ${JSON.stringify(x)}`);
}

function describeInbound(m: WebviewToHost): string {
  switch (m.t) {
    case 'ready': return 'ready';
    case 'create-session': return 'create-session';
    case 'set-visible': return 'set-visible';
    case 'set-layout': return 'set-layout';
    case 'close-session': return 'close-session';
    case 'delete-session': return 'delete-session';
    case 'send': return 'send';
    case 'interrupt': return 'interrupt';
    case 'cancel-queued': return 'cancel-queued';
    case 'set-effort': return 'set-effort';
    case 'set-permission-mode': return 'set-permission-mode';
    case 'set-include-context': return 'set-include-context';
    case 'attach-paste': return 'attach-paste';
    case 'attach-pick': return 'attach-pick';
    case 'attach-drop': return 'attach-drop';
    case 'attach-remove': return 'attach-remove';
    case 'attach-failed': return 'attach-failed';
    case 'reveal-file': return 'reveal-file';
    case 'set-model': return 'set-model';
    case 'permission-decision': return 'permission-decision';
    case 'question-answer': return 'question-answer';
    case 'load-more': return 'load-more';
    case 'request-context': return 'request-context';
    case 'open-file': return 'open-file';
    case 'answer-relocation': return 'answer-relocation';
    case 'cancel-relocation': return 'cancel-relocation';
    case 'fork-session': return 'fork-session';
    case 'request-bring-back': return 'request-bring-back';
    case 'bring-back': return 'bring-back';
    case 'request-stale-trees': return 'request-stale-trees';
    case 'remove-stale-tree': return 'remove-stale-tree';
    case 'request-fleet-diff': return 'request-fleet-diff';
    case 'open-review': return 'open-review';
    case 'open-fleet': return 'open-fleet';
    case 'focus-session': return 'focus-session';
    case 'open-fleet-subagent': return 'open-fleet-subagent';
    case 'open-file-diff': return 'open-file-diff';
    case 'refresh-catalog': return 'refresh-catalog';
    case 'open-settings': return 'open-settings';
    case 'login-provider': return 'login-provider';
    case 'open-external': return 'open-external';
    case 'export-table-csv': return 'export-table-csv';
    case 'file-search': return 'file-search';
    case 'agents-md-nudge-action': return 'agents-md-nudge-action';
    case 'set-favorite-models': return 'set-favorite-models';
    default: return assertNever(m);
  }
}

function describeOutbound(m: HostToWebview): string {
  switch (m.t) {
    case 'hydrate': return 'hydrate';
    case 'session-snapshot': return 'session-snapshot';
    case 'session-patch': return 'session-patch';
    case 'session-prepend': return 'session-prepend';
    case 'session-status': return 'session-status';
    case 'session-mcp': return 'session-mcp';
    case 'session-attachments': return 'session-attachments';
    case 'attachments-rejected': return 'attachments-rejected';
    case 'sessions-changed': return 'sessions-changed';
    case 'session-invocables': return 'session-invocables';
    case 'editor-context': return 'editor-context';
    case 'catalog': return 'catalog';
    case 'context-breakdown': return 'context-breakdown';
    case 'usage-windows': return 'usage-windows';
    case 'bring-back-plan': return 'bring-back-plan';
    case 'stale-trees': return 'stale-trees';
    case 'fleet-diff': return 'fleet-diff';
    case 'review-visibility': return 'review-visibility';
    case 'file-search-result': return 'file-search-result';
    case 'agents-md-nudge': return 'agents-md-nudge';
    case 'favorite-models': return 'favorite-models';
    case 'layout-changed': return 'layout-changed';
    case 'fleet-focus-subagent': return 'fleet-focus-subagent';
    default: return assertNever(m);
  }
}

suite('protocol', () => {
  test('inbound variants are exhaustively handled', () => {
    assert.strictEqual(describeInbound({ t: 'ready' }), 'ready');
    assert.strictEqual(describeInbound({ t: 'send', id: 's1', text: 'hi' }), 'send');
  });

  test('outbound variants are exhaustively handled', () => {
    assert.strictEqual(
      describeOutbound({ t: 'session-status', id: 's1', status: 'idle' }),
      'session-status',
    );
  });

  test('session-mcp is an outbound variant carrying a server list', () => {
    assert.strictEqual(
      describeOutbound({
        t: 'session-mcp',
        id: 's1',
        servers: [{ name: 'github', state: 'connected', toolCount: 12 }],
      }),
      'session-mcp',
    );
  });

  test('open-fleet-subagent is an inbound variant carrying a target subagent', () => {
    assert.strictEqual(
      describeInbound({ t: 'open-fleet-subagent', sessionId: 's1' as SessionId, itemId: 't1' }),
      'open-fleet-subagent',
    );
  });

  test('fleet-focus-subagent is an outbound variant carrying a target subagent', () => {
    assert.strictEqual(
      describeOutbound({ t: 'fleet-focus-subagent', sessionId: 's1' as SessionId, itemId: 't1' }),
      'fleet-focus-subagent',
    );
  });

  test('the new editor-context messages are part of the unions', () => {
    const toHost: WebviewToHost[] = [
      { t: 'set-include-context', id: 's1', on: false },
      { t: 'reveal-file', path: 'src/a.ts', startLine: 12 },
      { t: 'reveal-file', path: 'src/a.ts' },
    ];
    const toWebview: HostToWebview[] = [
      { t: 'editor-context', ctx: null },
      { t: 'editor-context', ctx: { path: 'src/a.ts', languageId: 'typescript' } },
    ];
    assert.strictEqual(toHost.length, 3);
    assert.strictEqual(toWebview.length, 2);
  });

  test('a context reply carries its session id alongside a result union', () => {
    assert.strictEqual(
      describeOutbound({
        t: 'context-breakdown', id: 's1',
        result: {
          ok: true,
          breakdown: {
            systemPercent: 12, memoryPercent: 4, conversationPercent: 27, freePercent: 57,
            memoryFiles: [],
          },
        },
      }),
      'context-breakdown',
    );
  });

  test('usage-windows carries a provider id and a plain window set, with no result union', () => {
    assert.strictEqual(
      describeOutbound({
        t: 'usage-windows', providerId: 'claude',
        windows: [{ id: 'five-hour', label: 'Session (5h)', usedPercent: 62 }],
      }),
      'usage-windows',
    );
  });

  test('a refused bring-back says whether the door should exist at all', () => {
    const toHost: WebviewToHost[] = [
      { t: 'request-bring-back', id: 's1' },
      { t: 'bring-back', id: 's1' },
    ];
    assert.strictEqual(toHost.length, 2);
    assert.strictEqual(
      describeOutbound({
        t: 'bring-back-plan', id: 's1',
        plan: { ok: false, reason: 'not a worktree', isWorktree: false },
      }),
      'bring-back-plan',
    );
    assert.strictEqual(
      describeOutbound({
        t: 'bring-back-plan', id: 's1',
        plan: { ok: true, branch: 'feat-x', worktree: '/t/feat-x', mainRoot: '/repo' },
      }),
      'bring-back-plan',
    );
  });

  test('the stale-tree sweep is panel-wide, and a row says who owns it', () => {
    // Neither inbound message carries a SessionId, and that is the point:
    // the sweep spans every session's directories at once, and a directory
    // nobody is sitting in has no session to address it to.
    const toHost: WebviewToHost[] = [
      { t: 'request-stale-trees' },
      { t: 'remove-stale-tree', path: '/repo/trees/feat-x' },
    ];
    assert.strictEqual(toHost.length, 2);
    const trees: StaleTree[] = [
      { path: '/repo/trees/feat-x', branch: 'feat-x', clean: true, sessionId: 's1' },
      { path: '/repo/trees/old', branch: 'old', clean: false, reason: 'uncommitted changes' },
    ];
    assert.strictEqual(trees[1].sessionId === undefined, true);
    assert.strictEqual(describeOutbound({ t: 'stale-trees', trees }), 'stale-trees');
  });

  test('a user item can carry an editor context', () => {
    const item: TranscriptItem = {
      id: 'u1', ts: 1, role: 'user', text: 'hi',
      context: {
        path: 'src/a.ts',
        languageId: 'typescript',
        selection: {
          ranges: [{ startLine: 1, endLine: 2, text: 'x' }],
          truncated: false,
        },
      },
    };
    assert.strictEqual(item.role, 'user');
  });

  test('ProviderInfo and UnavailableProvider carry an optional loginKind', () => {
    const info: ProviderInfo = {
      id: 'claude-work', displayName: 'Claude (work)', models: [], permissionModes: [],
      loginKind: 'none',
    };
    const unavailable: UnavailableProvider = {
      id: 'claude-work', displayName: 'Claude (work)', reason: 'x', loginKind: 'oauth',
    };
    assert.strictEqual(info.loginKind, 'none');
    assert.strictEqual(unavailable.loginKind, 'oauth');
  });
});

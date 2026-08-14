import * as assert from 'assert';
import type { HostToWebview, TranscriptItem, WebviewToHost } from '../../protocol/messages';

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
    case 'set-effort': return 'set-effort';
    case 'set-permission-mode': return 'set-permission-mode';
    case 'set-include-context': return 'set-include-context';
    case 'reveal-file': return 'reveal-file';
    case 'set-model': return 'set-model';
    case 'permission-decision': return 'permission-decision';
    case 'load-more': return 'load-more';
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
    case 'sessions-changed': return 'sessions-changed';
    case 'session-invocables': return 'session-invocables';
    case 'editor-context': return 'editor-context';
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
});

import * as assert from 'assert';
import type { HostToWebview, WebviewToHost } from '../../protocol/messages';

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
    case 'set-model': return 'set-model';
    case 'permission-decision': return 'permission-decision';
    case 'load-more': return 'load-more';
    case 'request-context': return 'request-context';
    case 'request-usage': return 'request-usage';
    case 'open-file': return 'open-file';
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
    case 'context-breakdown': return 'context-breakdown';
    case 'usage-windows': return 'usage-windows';
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

  test('context and usage replies carry their key alongside a result union', () => {
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
    assert.strictEqual(
      describeOutbound({
        t: 'usage-windows', providerId: 'claude',
        result: { ok: false, reason: 'No active session for this provider' },
      }),
      'usage-windows',
    );
  });
});

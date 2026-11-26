import * as assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { suite, test } from 'mocha';
import { decodeCode, decodePairingCode, encodeCode, encodePairingCode } from '../../sync/pairing-code';
import { checkServerUrl } from '../../sync/server-url';

suite('pairing code', () => {
  test('round-trips and tolerates case, spaces and look-alike letters', () => {
    const id = randomBytes(8);
    const secret = randomBytes(16);
    const code = encodePairingCode(id, secret);
    assert.strictEqual(code.startsWith('MRC-'), true);
    const decoded = decodePairingCode(code);
    assert.strictEqual(decoded?.pairingId.equals(id), true);
    assert.strictEqual(decoded?.secret.equals(secret), true);
    for (const variant of [code.toLowerCase(), code.replace(/-/g, ' '), code.replace(/0/g, 'O').replace(/1/g, 'I')]) {
      assert.strictEqual(decodePairingCode(variant)?.secret.equals(secret), true, variant);
    }
  });

  test('a wrong prefix or length is no code', () => {
    const code = encodePairingCode(randomBytes(8), randomBytes(16));
    assert.strictEqual(decodePairingCode(code.replace('MRC', 'MRB')), undefined);
    assert.strictEqual(decodePairingCode(code.slice(0, -3)), undefined);
    assert.strictEqual(decodePairingCode(''), undefined);
  });

  test('bootstrap codes use their own prefix', () => {
    const bytes = randomBytes(16);
    const code = encodeCode('MRB', bytes);
    assert.strictEqual(code.startsWith('MRB-'), true);
    assert.strictEqual(decodeCode('MRB', code, 16)?.equals(bytes), true);
    assert.strictEqual(decodeCode('MRC', code, 16), undefined);
  });
});

suite('checkServerUrl', () => {
  test('https is always fine and loses its trailing slash', () => {
    assert.deepStrictEqual(checkServerUrl('https://sync.example.com/'), { ok: true, base: 'https://sync.example.com' });
    assert.deepStrictEqual(checkServerUrl('https://sync.example.com/marcode/'), { ok: true, base: 'https://sync.example.com/marcode' });
  });

  for (const url of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'http://192.168.1.5', 'http://10.0.0.2', 'http://172.20.1.1', 'http://100.101.1.2', 'http://box.local']) {
    test(`plain http is allowed on a private address: ${url}`, () => {
      assert.strictEqual(checkServerUrl(url).ok, true);
    });
  }

  test('plain http to a public host is refused, naming https', () => {
    const verdict = checkServerUrl('http://sync.example.com');
    assert.strictEqual(verdict.ok, false);
    assert.strictEqual(!verdict.ok && verdict.reason.includes('https'), true);
    assert.strictEqual(checkServerUrl('http://172.32.0.1').ok, false);
  });

  test('other schemes and non-urls are refused', () => {
    assert.strictEqual(checkServerUrl('ftp://x').ok, false);
    assert.strictEqual(checkServerUrl('not a url').ok, false);
  });
});

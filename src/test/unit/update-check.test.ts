import * as assert from 'assert';
import {
  extractVersion, isNewer, localVersion, npmLatestVersion, githubLatestVersion,
} from '../../providers/update-check';

suite('update-check', () => {
  suite('extractVersion', () => {
    test('pulls a bare x.y.z', () => {
      assert.strictEqual(extractVersion('2.1.260'), '2.1.260');
    });
    test('pulls x.y.z out of a prefixed CLI banner', () => {
      assert.strictEqual(extractVersion('claude-code 2.1.260\n'), '2.1.260');
    });
    test('pulls x.y.z out of a tag with a name prefix', () => {
      assert.strictEqual(extractVersion('rust-v0.153.2'), '0.153.2');
    });
    test('returns undefined when no version-shaped substring exists', () => {
      assert.strictEqual(extractVersion('command not found'), undefined);
    });
  });

  suite('isNewer', () => {
    test('true when latest has a higher patch', () => {
      assert.strictEqual(isNewer('1.2.4', '1.2.3'), true);
    });
    test('true when latest has a higher minor', () => {
      assert.strictEqual(isNewer('1.3.0', '1.2.9'), true);
    });
    test('true when latest has a higher major', () => {
      assert.strictEqual(isNewer('2.0.0', '1.9.9'), true);
    });
    test('false when versions are equal', () => {
      assert.strictEqual(isNewer('1.2.3', '1.2.3'), false);
    });
    test('false when latest is older', () => {
      assert.strictEqual(isNewer('1.2.3', '1.3.0'), false);
    });
    test('false, never throws, when either side is malformed', () => {
      assert.strictEqual(isNewer('not-a-version', '1.2.3'), false);
      assert.strictEqual(isNewer('1.2.3', 'not-a-version'), false);
    });
  });

  suite('localVersion', () => {
    test('resolves the extracted version on success', async () => {
      const exec = async (bin: string, args: string[]) => {
        assert.strictEqual(bin, 'claude');
        assert.deepStrictEqual(args, ['--version']);
        return { stdout: '2.1.260\n' };
      };
      assert.strictEqual(await localVersion('claude', ['--version'], exec), '2.1.260');
    });
    test('resolves undefined when the spawn rejects', async () => {
      const exec = async () => { throw new Error('ENOENT'); };
      assert.strictEqual(await localVersion('claude', ['--version'], exec), undefined);
    });
    test('resolves undefined when stdout has no version-shaped text', async () => {
      const exec = async () => ({ stdout: 'command not found' });
      assert.strictEqual(await localVersion('claude', ['--version'], exec), undefined);
    });
  });

  suite('npmLatestVersion', () => {
    test('resolves the version field on a 2xx response', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ version: '2.1.260' }),
      })) as unknown as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), '2.1.260',
      );
    });
    test('resolves undefined on a non-2xx response', async () => {
      const fetchFn = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), undefined,
      );
    });
    test('resolves undefined when fetch rejects', async () => {
      const fetchFn = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), undefined,
      );
    });
    test('resolves undefined when the version field is missing', async () => {
      const fetchFn = (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
      assert.strictEqual(
        await npmLatestVersion('@anthropic-ai/claude-code', fetchFn), undefined,
      );
    });
  });

  suite('githubLatestVersion', () => {
    test('resolves tag_name with the prefix stripped', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-v0.153.2' }),
      })) as unknown as typeof fetch;
      assert.strictEqual(
        await githubLatestVersion('openai/codex', 'rust-v', fetchFn), '0.153.2',
      );
    });
    test('resolves tag_name unchanged when the prefix does not match', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ tag_name: '0.153.2' }),
      })) as unknown as typeof fetch;
      assert.strictEqual(
        await githubLatestVersion('openai/codex', 'rust-v', fetchFn), '0.153.2',
      );
    });
    test('resolves undefined on a non-2xx response', async () => {
      const fetchFn = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
      assert.strictEqual(await githubLatestVersion('openai/codex', 'rust-v', fetchFn), undefined);
    });
    test('resolves undefined when fetch rejects', async () => {
      const fetchFn = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
      assert.strictEqual(await githubLatestVersion('openai/codex', 'rust-v', fetchFn), undefined);
    });
    test('runs extractVersion on the stripped tag, dropping a trailing suffix', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-v0.153.2-beta' }),
      })) as unknown as typeof fetch;
      assert.strictEqual(
        await githubLatestVersion('openai/codex', 'rust-v', fetchFn), '0.153.2',
      );
    });
    test('resolves undefined when the stripped tag has no version-shaped substring', async () => {
      const fetchFn = (async () => ({
        ok: true, json: async () => ({ tag_name: 'rust-vnightly' }),
      })) as unknown as typeof fetch;
      assert.strictEqual(
        await githubLatestVersion('openai/codex', 'rust-v', fetchFn), undefined,
      );
    });
  });

  suite('failure logging', () => {
    let warnCalls: unknown[][];
    let originalWarn: typeof console.warn;

    setup(() => {
      warnCalls = [];
      originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnCalls.push(args); };
    });

    teardown(() => {
      console.warn = originalWarn;
    });

    test('localVersion logs a console.warn on spawn failure', async () => {
      const exec = async () => { throw new Error('ENOENT'); };
      await localVersion('claude', ['--version'], exec);
      assert.strictEqual(warnCalls.length, 1);
      assert.strictEqual(warnCalls[0][0], '[mar-code] update-check: local version probe failed for');
      assert.strictEqual(warnCalls[0][1], 'claude');
    });

    test('npmLatestVersion logs a console.warn when fetch rejects', async () => {
      const fetchFn = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
      await npmLatestVersion('@anthropic-ai/claude-code', fetchFn);
      assert.strictEqual(warnCalls.length, 1);
      assert.strictEqual(
        warnCalls[0][0], '[mar-code] update-check: npm latest-version lookup failed for',
      );
      assert.strictEqual(warnCalls[0][1], '@anthropic-ai/claude-code');
    });

    test('githubLatestVersion logs a console.warn when fetch rejects', async () => {
      const fetchFn = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
      await githubLatestVersion('openai/codex', 'rust-v', fetchFn);
      assert.strictEqual(warnCalls.length, 1);
      assert.strictEqual(
        warnCalls[0][0], '[mar-code] update-check: github latest-release lookup failed for',
      );
      assert.strictEqual(warnCalls[0][1], 'openai/codex');
    });
  });

  suite('timeouts', () => {
    test('realExecVersion is not exported, but localVersion still resolves undefined on a timeout-shaped error', async () => {
      // execFile's own `timeout` handles the process kill; this exercises the
      // same rejection path localVersion already covers via ExecVersionFn,
      // confirming a timeout-style error (ETIMEDOUT) resolves undefined
      // rather than throwing.
      const exec = async () => { const e = new Error('ETIMEDOUT'); throw e; };
      assert.strictEqual(await localVersion('claude', ['--version'], exec), undefined);
    });

    test('npmLatestVersion passes an AbortSignal to fetchFn', async () => {
      let sawSignal: AbortSignal | undefined;
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        sawSignal = init?.signal ?? undefined;
        return { ok: true, json: async () => ({ version: '1.0.0' }) };
      }) as unknown as typeof fetch;
      await npmLatestVersion('pkg', fetchFn);
      assert.strictEqual(sawSignal instanceof AbortSignal, true);
    });

    test('githubLatestVersion passes an AbortSignal to fetchFn', async () => {
      let sawSignal: AbortSignal | undefined;
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        sawSignal = init?.signal ?? undefined;
        return { ok: true, json: async () => ({ tag_name: '1.0.0' }) };
      }) as unknown as typeof fetch;
      await githubLatestVersion('openai/codex', 'rust-v', fetchFn);
      assert.strictEqual(sawSignal instanceof AbortSignal, true);
    });
  });
});

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
  });
});

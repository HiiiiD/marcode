import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, suite } from 'mocha';
import { copySkillsAndPlugins } from '../../host/copy-skills-plugins';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'marcode-copy-test-'));
}

suite('host/copy-skills-plugins', () => {
  test('copies skills/ and plugins/ into an empty target', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'skills', 'my-skill'), { recursive: true });
    await fs.writeFile(path.join(source, 'skills', 'my-skill', 'SKILL.md'), '# hi');
    await fs.mkdir(path.join(source, 'plugins'), { recursive: true });
    await fs.writeFile(path.join(source, 'plugins', 'marketplace.json'), '{}');

    const result = await copySkillsAndPlugins(source, target);

    assert.deepStrictEqual(result.copied.sort(), ['plugins', 'skills']);
    assert.strictEqual(
      await fs.readFile(path.join(target, 'skills', 'my-skill', 'SKILL.md'), 'utf8'),
      '# hi',
    );
    assert.strictEqual(
      await fs.readFile(path.join(target, 'plugins', 'marketplace.json'), 'utf8'),
      '{}',
    );
  });

  test('skips a subdirectory that does not exist at the source', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'skills'), { recursive: true });

    const result = await copySkillsAndPlugins(source, target);

    assert.deepStrictEqual(result.copied, ['skills']);
    await assert.rejects(fs.access(path.join(target, 'plugins')));
  });

  test('never touches sibling files outside skills/plugins', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'skills'), { recursive: true });
    await fs.writeFile(path.join(source, 'auth.json'), '{"secret":true}');

    await copySkillsAndPlugins(source, target);

    await assert.rejects(fs.access(path.join(target, 'auth.json')));
  });

  test('copies an explicit subdirs list instead of the default', async () => {
    const source = await makeTempDir();
    const target = await makeTempDir();
    await fs.mkdir(path.join(source, 'commands'), { recursive: true });
    await fs.writeFile(path.join(source, 'commands', 'foo.md'), '# foo');
    await fs.mkdir(path.join(source, 'plugins'), { recursive: true });

    const result = await copySkillsAndPlugins(source, target, ['commands']);

    assert.deepStrictEqual(result.copied, ['commands']);
    assert.strictEqual(
      await fs.readFile(path.join(target, 'commands', 'foo.md'), 'utf8'),
      '# foo',
    );
    await assert.rejects(fs.access(path.join(target, 'plugins')));
  });
});

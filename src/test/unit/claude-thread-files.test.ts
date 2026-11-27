import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { suite, test } from 'mocha';
import { projectSlug } from '../../providers/claude/session-file';
import { ClaudeProvider } from '../../providers/claude/claude-provider';

async function provider() {
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'mar-claude-cfg-'));
  const claude = new ClaudeProvider(undefined, undefined, { env: { CLAUDE_CONFIG_DIR: config } });
  return { config, claude, projects: path.join(config, 'projects') };
}

suite('Claude native thread files', () => {
  test('threadFiles names the session file for its cwd, or nothing when it is missing', async () => {
    const p = await provider();
    assert.deepStrictEqual(await p.claude.threadFiles({ resumeToken: 'abc', cwd: '/w/repo' }), []);
    const file = path.join(p.projects, projectSlug('/w/repo'), 'abc.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"cwd":"/w/repo"}\n');
    assert.deepStrictEqual(await p.claude.threadFiles({ resumeToken: 'abc', cwd: '/w/repo' }), [file]);
  });

  test('importThread writes the file under the new cwd and keeps the token', async () => {
    const p = await provider();
    const result = await p.claude.importThread({ resumeToken: 'abc', cwd: '/x/repo', files: [{ name: 'abc.jsonl', text: '{"cwd":"/x/repo"}\n' }] });
    assert.deepStrictEqual(result, { resumeToken: 'abc' });
    assert.strictEqual(await fs.readFile(path.join(p.projects, projectSlug('/x/repo'), 'abc.jsonl'), 'utf8'), '{"cwd":"/x/repo"}\n');
  });

  test('importThread answers false when it cannot write', async () => {
    const p = await provider();
    await fs.writeFile(p.projects, 'not a directory');
    assert.strictEqual(await p.claude.importThread({ resumeToken: 'abc', cwd: '/x/repo', files: [{ name: 'abc.jsonl', text: 'x' }] }), false);
  });
});

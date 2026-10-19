import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { copySessionFile, projectSlug, sessionsRoot } from '../../providers/claude/session-file';

suite('claude session file', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'marcode-sess-')); });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const seed = (cwd: string, id: string, body: string) => {
    const dir = path.join(root, projectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), body);
  };

  test('projectSlug replaces every non-alphanumeric character', () => {
    const bs = String.fromCharCode(92);
    assert.strictEqual(projectSlug(['C:', 'Users', 'm', 'repo'].join(bs)), 'C--Users-m-repo');
    assert.strictEqual(projectSlug('/home/m/my.repo/'), '-home-m-my-repo-');
  });

  test('copySessionFile copies the jsonl into the destination slug and leaves the source', async () => {
    seed('/a/old', 's1', '{"x":1}\n');
    assert.strictEqual(await copySessionFile(root, '/a/old', '/b/new', 's1'), true);
    const src = fs.readFileSync(path.join(root, projectSlug('/a/old'), 's1.jsonl'), 'utf8');
    const dst = fs.readFileSync(path.join(root, projectSlug('/b/new'), 's1.jsonl'), 'utf8');
    assert.strictEqual(dst, src);
  });

  test('copySessionFile works when the source directory path no longer exists on disk', async () => {
    seed('/gone/dir', 's2', 'data');
    assert.strictEqual(await copySessionFile(root, '/gone/dir', '/also/gone', 's2'), true);
  });

  test('copySessionFile returns false when the source jsonl is missing', async () => {
    assert.strictEqual(await copySessionFile(root, '/a/old', '/b/new', 'nope'), false);
  });

  test('copySessionFile returns false and does not throw when the destination cannot be created', async () => {
    seed('/a/old', 's3', 'data');
    fs.writeFileSync(path.join(root, projectSlug('/b/new')), 'i am a file');
    assert.strictEqual(await copySessionFile(root, '/a/old', '/b/new', 's3'), false);
  });

  test('sessionsRoot prefers the instance env CLAUDE_CONFIG_DIR over process.env', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'proc');
    try {
      assert.strictEqual(sessionsRoot({ CLAUDE_CONFIG_DIR: path.join(root, 'inst') }), path.join(root, 'inst', 'projects'));
      assert.strictEqual(sessionsRoot(undefined), path.join(root, 'proc', 'projects'));
    } finally {
      if (prev === undefined) { delete process.env.CLAUDE_CONFIG_DIR; } else { process.env.CLAUDE_CONFIG_DIR = prev; }
    }
  });
});

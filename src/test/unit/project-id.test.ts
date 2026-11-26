import * as assert from 'node:assert';
import { suite, test } from 'mocha';
import { ownProjectId, projectIdFromRemote } from '../../shared/project-id';

suite('projectIdFromRemote', () => {
  const same = 'github.com/Efebia/Marcode';
  for (const url of [
    'git@github.com:Efebia/Marcode.git',
    'https://github.com/Efebia/Marcode.git',
    'https://user:tok@GitHub.com/Efebia/Marcode/',
    'ssh://git@github.com:22/Efebia/Marcode',
    'git+ssh://git@github.com/Efebia/Marcode.git',
  ]) {
    test(`normalises ${url}`, () => { assert.strictEqual(projectIdFromRemote(url), same); });
  }

  test('keeps path case', () => {
    assert.notStrictEqual(projectIdFromRemote('https://gitlab.com/a/Repo'), projectIdFromRemote('https://gitlab.com/a/repo'));
  });

  test('local path remotes become file ids', () => {
    assert.strictEqual(projectIdFromRemote('/srv/git/foo.git'), 'file:/srv/git/foo');
    assert.strictEqual(projectIdFromRemote('file:///srv/git/foo'), 'file:/srv/git/foo');
    assert.strictEqual(projectIdFromRemote('C:\\git\\foo.git'), 'file:C:/git/foo');
  });

  test('empty or whitespace is no project', () => {
    assert.strictEqual(projectIdFromRemote(''), undefined);
    assert.strictEqual(projectIdFromRemote('   '), undefined);
  });

  test('ownProjectId is local: plus the normalised root', () => {
    assert.strictEqual(ownProjectId('/Volumes/SSD/x/', 'darwin'), 'local:/volumes/ssd/x');
  });
});

import * as assert from 'assert';
import {
  AgentsMdNudgeController, applyHit, buildExcludeGlob, groupIntoDirEntries, scanForHits,
} from '../../host/agents-md-nudge';
import type { HostToWebview } from '../../protocol/messages';

suite('buildExcludeGlob', () => {
  test('with no extras, is just the built-in excludes', () => {
    assert.strictEqual(
      buildExcludeGlob([]),
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}',
    );
  });

  test('treats a bare path segment as matching anywhere in the tree', () => {
    assert.strictEqual(
      buildExcludeGlob(['.claude/worktrees']),
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/.claude/worktrees/**}',
    );
  });

  test('passes an entry containing "*" through untouched', () => {
    assert.strictEqual(
      buildExcludeGlob(['**/vendor/**']),
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/vendor/**}',
    );
  });

  test('trims whitespace, strips leading/trailing slashes, drops empty entries', () => {
    assert.strictEqual(
      buildExcludeGlob([' /tmp/ ', '']),
      '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/tmp/**}',
    );
  });
});

suite('scanForHits', () => {
  test('flags a dir with CLAUDE.md but no AGENTS.md as migrate', () => {
    const hits = scanForHits(
      [{ dir: 'pkg-a', hasClaudeMd: true, hasAgentsMd: false }],
      { hasClaudeProvider: true, dismissed: new Set() },
    );
    assert.deepStrictEqual(hits, [{ dir: 'pkg-a', kind: 'migrate' }]);
  });

  test('flags a dir with AGENTS.md but no CLAUDE.md as add-stub when claude is enabled', () => {
    const hits = scanForHits(
      [{ dir: 'pkg-b', hasClaudeMd: false, hasAgentsMd: true }],
      { hasClaudeProvider: true, dismissed: new Set() },
    );
    assert.deepStrictEqual(hits, [{ dir: 'pkg-b', kind: 'add-stub' }]);
  });

  test('does not flag add-stub when claude provider is disabled', () => {
    const hits = scanForHits(
      [{ dir: 'pkg-b', hasClaudeMd: false, hasAgentsMd: true }],
      { hasClaudeProvider: false, dismissed: new Set() },
    );
    assert.deepStrictEqual(hits, []);
  });

  test('does not flag a dir with both files', () => {
    const hits = scanForHits(
      [{ dir: 'pkg-c', hasClaudeMd: true, hasAgentsMd: true }],
      { hasClaudeProvider: true, dismissed: new Set() },
    );
    assert.deepStrictEqual(hits, []);
  });

  test('does not flag a dir with neither file', () => {
    const hits = scanForHits(
      [{ dir: 'pkg-d', hasClaudeMd: false, hasAgentsMd: false }],
      { hasClaudeProvider: true, dismissed: new Set() },
    );
    assert.deepStrictEqual(hits, []);
  });

  test('filters out dismissed dirs', () => {
    const hits = scanForHits(
      [{ dir: 'pkg-a', hasClaudeMd: true, hasAgentsMd: false }],
      { hasClaudeProvider: true, dismissed: new Set(['pkg-a']) },
    );
    assert.deepStrictEqual(hits, []);
  });
});

suite('groupIntoDirEntries', () => {
  test('groups relative file paths by directory', () => {
    const entries = groupIntoDirEntries([
      'pkg-a/CLAUDE.md',
      'pkg-b/AGENTS.md',
      'pkg-b/CLAUDE.md',
    ]);
    assert.deepStrictEqual(
      [...entries].sort((a, b) => a.dir.localeCompare(b.dir)),
      [
        { dir: 'pkg-a', hasClaudeMd: true, hasAgentsMd: false },
        { dir: 'pkg-b', hasClaudeMd: true, hasAgentsMd: true },
      ],
    );
  });

  test('treats a root-level file as dir "."', () => {
    const entries = groupIntoDirEntries(['CLAUDE.md']);
    assert.deepStrictEqual(entries, [{ dir: '.', hasClaudeMd: true, hasAgentsMd: false }]);
  });
});

suite('applyHit', () => {
  function fakeFs(initial: Record<string, string>) {
    const files = { ...initial };
    const writes: Record<string, string> = {};
    return {
      files, writes,
      readFile: async (p: string) => {
        if (!(p in files)) {throw new Error(`ENOENT: ${p}`);}
        return files[p];
      },
      writeFile: async (p: string, content: string) => { writes[p] = content; files[p] = content; },
    };
  }

  test('migrate moves CLAUDE.md content to AGENTS.md and stubs CLAUDE.md', async () => {
    const fs = fakeFs({ '/repo/pkg-a/CLAUDE.md': 'real instructions\n' });
    await applyHit(
      { dir: 'pkg-a', kind: 'migrate' },
      { claudeMdPath: '/repo/pkg-a/CLAUDE.md', agentsMdPath: '/repo/pkg-a/AGENTS.md' },
      fs,
    );
    assert.strictEqual(fs.writes['/repo/pkg-a/AGENTS.md'], 'real instructions\n');
    assert.strictEqual(fs.writes['/repo/pkg-a/CLAUDE.md'], '@AGENTS.md\n');
  });

  test('add-stub writes only the stub CLAUDE.md, no read', async () => {
    const fs = fakeFs({});
    await applyHit(
      { dir: 'pkg-b', kind: 'add-stub' },
      { claudeMdPath: '/repo/pkg-b/CLAUDE.md', agentsMdPath: '/repo/pkg-b/AGENTS.md' },
      fs,
    );
    assert.strictEqual(fs.writes['/repo/pkg-b/CLAUDE.md'], '@AGENTS.md\n');
    assert.strictEqual('/repo/pkg-b/AGENTS.md' in fs.writes, false);
  });
});

suite('AgentsMdNudgeController', () => {
  function makeController(opts: {
    relativePaths: string[];
    hasClaudeProvider?: boolean;
    files?: Record<string, string>;
    failOn?: string; // dir whose readFile/writeFile should throw
  }) {
    const posted: HostToWebview[] = [];
    const dismissed = new Set<string>();
    const files = { ...(opts.files ?? {}) };
    const controller = new AgentsMdNudgeController({
      findRelativePaths: async () => opts.relativePaths,
      hasClaudeProvider: opts.hasClaudeProvider ?? true,
      dismiss: {
        get: () => dismissed,
        add: async (dirs) => { for (const d of dirs) {dismissed.add(d);} },
      },
      resolvePaths: (dir) => ({
        claudeMdPath: `${dir}/CLAUDE.md`, agentsMdPath: `${dir}/AGENTS.md`,
      }),
      fs: {
        readFile: async (p) => {
          if (opts.failOn && p.startsWith(opts.failOn)) {throw new Error('boom');}
          return files[p] ?? '';
        },
        writeFile: async (p, content) => {
          if (opts.failOn && p.startsWith(opts.failOn)) {throw new Error('boom');}
          files[p] = content;
        },
      },
      post: (m) => posted.push(m),
    });
    return { controller, posted, dismissed, files };
  }

  test('scan posts hits for drifted dirs, none for a dismissed dir', async () => {
    const { controller, posted } = makeController({
      relativePaths: ['pkg-a/CLAUDE.md', 'pkg-b/AGENTS.md'],
    });
    await controller.scan();
    const msg = posted.find((m) => m.t === 'agents-md-nudge');
    assert.deepStrictEqual(msg, {
      t: 'agents-md-nudge',
      hits: [{ dir: 'pkg-a', kind: 'migrate' }, { dir: 'pkg-b', kind: 'add-stub' }],
    });
  });

  test('dismiss action removes the dir from the posted hits and persists it', async () => {
    const { controller, posted, dismissed } = makeController({
      relativePaths: ['pkg-a/CLAUDE.md'],
    });
    await controller.scan();
    await controller.handleAction('dismiss', ['pkg-a']);
    const last = posted[posted.length - 1];
    assert.deepStrictEqual(last, { t: 'agents-md-nudge', hits: [] });
    assert.strictEqual(dismissed.has('pkg-a'), true);
  });

  test('migrate action moves content and drops the dir from the card', async () => {
    const { controller, posted, files } = makeController({
      relativePaths: ['pkg-a/CLAUDE.md'],
      files: { 'pkg-a/CLAUDE.md': 'instructions\n' },
    });
    await controller.scan();
    await controller.handleAction('migrate', ['pkg-a']);
    assert.strictEqual(files['pkg-a/AGENTS.md'], 'instructions\n');
    assert.strictEqual(files['pkg-a/CLAUDE.md'], '@AGENTS.md\n');
    const last = posted[posted.length - 1];
    assert.deepStrictEqual(last, { t: 'agents-md-nudge', hits: [] });
  });

  test('a failed migrate keeps the dir on the card with an error, does not dismiss it', async () => {
    const { controller, posted, dismissed } = makeController({
      relativePaths: ['pkg-a/CLAUDE.md'],
      failOn: 'pkg-a',
    });
    await controller.scan();
    await controller.handleAction('migrate', ['pkg-a']);
    const last = posted[posted.length - 1];
    assert.deepStrictEqual(last, {
      t: 'agents-md-nudge',
      hits: [{ dir: 'pkg-a', kind: 'migrate', error: 'boom' }],
    });
    assert.strictEqual(dismissed.has('pkg-a'), false);
  });
});

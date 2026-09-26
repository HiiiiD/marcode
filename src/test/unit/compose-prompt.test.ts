import * as assert from 'node:assert';
import { bareNamesOf, composePrompt } from '../../providers/compose-prompt';
import { parseSkillNames } from '../../providers/opencode/skill-names';
import { toInvocables } from '../../providers/claude/map-commands';
import type { EditorContext } from '../../providers/types';

const ctx: EditorContext = {
  path: 'a.ts', languageId: 'typescript',
  selection: { ranges: [{ startLine: 1, endLine: 2, text: 'x' }], truncated: false },
};
const bare = new Set(['compact']);

suite('composePrompt', () => {
  test('a bare command goes out verbatim and keeps the intro for later', () => {
    const r = composePrompt('/compact focus on tests', ctx, bare, false, false);
    assert.strictEqual(r.body, '/compact focus on tests');
    assert.strictEqual(r.introduced, false);
  });

  test('a non-bare command still gets the editor context', () => {
    const r = composePrompt('/my-skill', ctx, bare, true, false);
    assert.strictEqual(r.body.startsWith('<editor-context'), true);
    assert.strictEqual(r.body.endsWith('/my-skill'), true);
  });

  test('plain text is framed and marks the session introduced', () => {
    const r = composePrompt('hi', undefined, bare, false, false);
    assert.strictEqual(r.body.includes('<marcode-context>'), true);
    assert.strictEqual(r.introduced, true);
  });

  test('a bare name only matches at the start of the message', () => {
    const r = composePrompt('run /compact please', ctx, bare, true, false);
    assert.strictEqual(r.body.startsWith('<editor-context'), true);
  });
});

suite('bare command detection', () => {
  test('claude marks only builtin rows', () => {
    const entries = toInvocables([
      { name: 'compact', description: 'd', argumentHint: '', builtin: true },
      { name: 'my-skill', description: 'd', argumentHint: '' },
    ]);
    assert.deepStrictEqual([...bareNamesOf(entries)], ['compact']);
  });

  test('a builtin alias is bare unless another row owns that name', () => {
    const entries = toInvocables([
      { name: 'usage', description: 'd', argumentHint: '', builtin: true, aliases: ['cost', 'stats'] },
      { name: 'stats', description: 'd', argumentHint: '' },
    ]);
    assert.deepStrictEqual([...bareNamesOf(entries)].sort(), ['cost', 'usage']);
  });

  test('parseSkillNames tolerates log noise and rejects garbage', () => {
    const names = parseSkillNames('INFO x\n[{"name":"pdf"},{"name":"xlsx"}]\n');
    assert.deepStrictEqual([...(names ?? [])], ['pdf', 'xlsx']);
    assert.strictEqual(parseSkillNames('nope') === undefined, true);
  });
});

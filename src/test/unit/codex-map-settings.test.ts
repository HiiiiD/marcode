import * as assert from 'assert';
import { CODEX_MODES, codexSettings, effortLevelsOf, sandboxPolicyOf } from '../../providers/codex/map-settings';

suite('codexSettings', () => {
  test('default asks the user, sandboxed to the workspace', () => {
    assert.deepStrictEqual(codexSettings('default'), {
      approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user',
    });
  });

  test('auto differs from default only in who answers', () => {
    // "Approve for me": approvalPolicy decides whether an approval is raised,
    // approvalsReviewer decides who answers it. This is the whole feature.
    assert.deepStrictEqual(codexSettings('auto'), {
      approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review',
    });
  });

  test('plan cannot write and never prompts', () => {
    assert.deepStrictEqual(codexSettings('plan'), {
      approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user',
    });
  });

  test('dontAsk refuses without prompting', () => {
    assert.deepStrictEqual(codexSettings('dontAsk'), {
      approvalPolicy: 'never', sandbox: 'workspace-write', approvalsReviewer: 'user',
    });
  });

  test('bypass is the only mode that leaves the sandbox', () => {
    assert.deepStrictEqual(codexSettings('bypass'), {
      approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user',
    });
  });

  test('acceptEdits falls back rather than aliasing default', () => {
    // Not offered, so it should never be asked for; if it is, landing on
    // default is the honest answer.
    assert.strictEqual(codexSettings('acceptEdits').sandbox, 'workspace-write');
  });
});

suite('CODEX_MODES', () => {
  test('offers five modes and omits acceptEdits', () => {
    assert.deepStrictEqual(CODEX_MODES.map((m) => m.id),
      ['default', 'auto', 'plan', 'dontAsk', 'bypass']);
  });

  test('includes default, which resolution depends on', () => {
    assert.strictEqual(CODEX_MODES.some((m) => m.id === 'default'), true);
  });
});

suite('sandboxPolicyOf', () => {
  test('builds the struct form a turn override needs', () => {
    // thread/start takes the bare SandboxMode enum; turn/start takes the
    // SandboxPolicy struct. Same mode, two spellings.
    assert.deepStrictEqual(sandboxPolicyOf('plan'), { type: 'readOnly', networkAccess: false });
    assert.deepStrictEqual(sandboxPolicyOf('bypass'), { type: 'dangerFullAccess' });
    assert.deepStrictEqual(sandboxPolicyOf('default'), {
      type: 'workspaceWrite', writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    });
  });
});

suite('effortLevelsOf', () => {
  test('carries the newest models\' full scale, ultra included', () => {
    // Measured against codex-cli 0.147.0 on 2026-08-14: gpt-5.6-sol reports
    // exactly these six. 'ultra' is the only value that was outside
    // EffortLevel, which is why the union gained it rather than this function
    // gaining a filter — dropping it would silently remove the top level of
    // the newest model.
    const effort = effortLevelsOf({
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'high', description: '' },
        { reasoningEffort: 'xhigh', description: '' },
        { reasoningEffort: 'max', description: '' },
        { reasoningEffort: 'ultra', description: '' },
      ],
      defaultReasoningEffort: 'low',
    });
    assert.deepStrictEqual(effort, {
      levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'low',
    });
  });

  test('an older model\'s shorter scale is carried as-is', () => {
    // gpt-5.5 and gpt-5.4 stop at xhigh. The scale is per model, so nothing
    // pads it out to match its newer siblings.
    const effort = effortLevelsOf({
      id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'medium', description: '' },
        { reasoningEffort: 'high', description: '' },
        { reasoningEffort: 'xhigh', description: '' },
      ],
      defaultReasoningEffort: 'medium',
    });
    assert.deepStrictEqual(effort, {
      levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium',
    });
  });

  test('a level we cannot express is dropped rather than invented', () => {
    // ReasoningEffort is an open string: Codex can add a level between
    // releases. Not observed in 0.147.0, but the union is closed and shared
    // with every other provider, so an unknown value is skipped instead of
    // widening the slider for everyone.
    const effort = effortLevelsOf({
      id: 'future', displayName: 'Future', hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '' },
        { reasoningEffort: 'hyper', description: '' },
      ],
      defaultReasoningEffort: 'low',
    });
    assert.deepStrictEqual(effort, { levels: ['low'], default: 'low' });
  });

  test('a model with no expressible level gets no effort control', () => {
    const effort = effortLevelsOf({
      id: 'x', displayName: 'X', hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'hyper', description: '' }],
      defaultReasoningEffort: 'hyper',
    });
    assert.strictEqual(effort, undefined);
  });
});

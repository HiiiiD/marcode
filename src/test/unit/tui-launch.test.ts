import * as assert from 'node:assert';
import type { ProviderInfo } from '../../protocol/messages';
import { launchPlan } from '../../tui/view/launch';
import { catalog, singlePaneLayout, summary } from '../fixtures/protocol';

const base = { ready: true, probing: false, sessions: [summary('a', { updatedAt: 5 }), summary('b', { updatedAt: 9 })], catalog: catalog(), layout: singlePaneLayout('a'), forceNew: false };

suite('tui launch plan', () => {
  test('waits until hydrated', () => {
    assert.strictEqual(launchPlan({ ...base, ready: false }).kind, 'wait');
  });
  test('resumes the focused session, else the first layout leaf, else the newest', () => {
    assert.deepStrictEqual(launchPlan({ ...base, layout: { ...singlePaneLayout('a'), focusedSessionId: 'b' } }), { kind: 'resume', sessionId: 'b' });
    assert.deepStrictEqual(launchPlan(base), { kind: 'resume', sessionId: 'a' });
    assert.deepStrictEqual(launchPlan({ ...base, layout: singlePaneLayout('gone') }), { kind: 'resume', sessionId: 'b' });
  });
  test('a prompt or --new creates with the default provider and seeds the prompt', () => {
    const plan = launchPlan({ ...base, prompt: 'fix the tests' });
    assert.strictEqual(plan.kind, 'create');
    assert.deepStrictEqual(plan.kind === 'create' && plan.seed, { text: 'fix the tests' });
    assert.strictEqual(launchPlan({ ...base, forceNew: true }).kind, 'create');
  });
  test('the default provider is the newest session provider when in the catalog', () => {
    const two: ProviderInfo[] = [{ ...catalog()[0], id: 'other' }, catalog()[0]];
    const plan = launchPlan({ ...base, catalog: two, forceNew: true });
    assert.strictEqual(plan.kind === 'create' && plan.providerId, 'fake');
    const gone = launchPlan({ ...base, catalog: [{ ...catalog()[0], id: 'other' }], forceNew: true });
    assert.strictEqual(gone.kind === 'create' && gone.providerId, 'other');
  });
  test('with no available provider the prompt is kept in an empty plan, never dropped', () => {
    assert.deepStrictEqual(launchPlan({ ...base, catalog: [], prompt: 'go' }), { kind: 'empty', pendingPrompt: 'go' });
  });
  test('forceNew without a prompt and no providers is a plain empty plan', () => {
    const plan = launchPlan({ ...base, catalog: [], forceNew: true });
    assert.deepStrictEqual(plan, { kind: 'empty' });
    assert.strictEqual('pendingPrompt' in plan, false);
  });
  test('a prompt while still probing with an empty catalog waits', () => {
    assert.strictEqual(launchPlan({ ...base, catalog: [], probing: true, prompt: 'go' }).kind, 'wait');
  });
  test('a first provider with no models creates with an undefined model', () => {
    const plan = launchPlan({ ...base, catalog: [{ ...catalog()[0], models: [] }], forceNew: true });
    assert.strictEqual(plan.kind, 'create');
    assert.strictEqual(plan.kind === 'create' && plan.model, undefined);
  });
  test('still probing with nothing to go on waits', () => {
    assert.strictEqual(launchPlan({ ...base, catalog: [], sessions: [], probing: true }).kind, 'wait');
  });
  test('no sessions and a ready catalog is the empty state', () => {
    assert.deepStrictEqual(launchPlan({ ...base, sessions: [] }), { kind: 'empty' });
  });
});

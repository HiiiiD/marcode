import * as assert from 'assert';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionSnapshot, TranscriptItem } from '../../protocol/messages';
import { catalog, layoutOf, permission, question, snapshot, summary, tool } from '../fixtures/protocol';
import { posted, renderApp, sendFromHost } from './harness';

function hydrate(items: TranscriptItem[], over: Partial<SessionSnapshot> = {}) {
  sendFromHost({
    t: 'hydrate', sessions: [summary('a')], layout: layoutOf(['a']),
    snapshots: [snapshot('a', { items, ...over })],
    catalog: catalog(), unavailable: [], usage: {},
  });
}

suite('Pinned prompts', () => {
  test('pins a main-agent permission outside the transcript and posts its decision', async () => {
    const { container } = renderApp();
    const item = permission();
    hydrate([item], { pending: [{ requestId: item.requestId, tool: item.tool }] });

    const region = screen.getByRole('region', { name: 'Pending prompts' });
    const allow = within(region).getByRole('button', { name: 'Allow Write' });
    assert.strictEqual(screen.getAllByRole('button', { name: 'Allow Write' }).length, 1);
    assert.strictEqual(region.closest('[data-slot="message-scroller"]') === null, true);
    assert.strictEqual(container.contains(region), true);
    await userEvent.click(allow);
    assert.deepStrictEqual(posted().at(-1), {
      t: 'permission-decision', id: 'a', requestId: 'r1', decision: { allow: true },
    });

    sendFromHost({ t: 'session-patch', id: 'a',
      patch: { op: 'replace', item: { ...item, state: 'allowed' } },
    });
    assert.strictEqual(screen.queryByRole('region', { name: 'Pending prompts' }) === null, true);
    screen.getByText('Write — allowed');
  });

  test('keeps question selections when navigating past a subagent permission', async () => {
    renderApp();
    const ask = question({ requestId: 'question-r' });
    const approval = permission({ id: 'p1', requestId: 'permission-r', ts: 3 });
    const parent = tool({
      id: 'agent1', toolId: 'agent1', state: 'running', ts: 2,
      tool: { kind: 'subagent', label: 'Task', action: 'spawn', agent: 'Explore' },
      children: [approval],
    });
    hydrate([ask, parent], {
      pending: [{ requestId: approval.requestId, tool: approval.tool }],
      pendingQuestions: [{ requestId: ask.requestId, blocking: true, questions: ask.questions }],
    });

    const region = screen.getByRole('region', { name: 'Pending prompts' });
    screen.getByText('Prompt 1 of 2');
    const option = 'Question cards only. Smaller blast radius';
    await userEvent.click(within(region).getByRole('radio', { name: option }));
    await userEvent.click(within(region).getByRole('button', { name: 'Next prompt' }));
    screen.getByText('Prompt 2 of 2');
    within(region).getByText('Subagent: Explore');
    assert.strictEqual(screen.getAllByRole('button', { name: 'Allow Write' }).length, 1);
    await userEvent.click(within(region).getByRole('button', { name: 'Previous prompt' }));
    assert.strictEqual(within(region).getByRole('radio', { name: option }).getAttribute('aria-checked'), 'true');
    await userEvent.click(within(region).getByRole('button', { name: 'Answer' }));
    assert.deepStrictEqual(posted().at(-1), {
      t: 'question-answer', id: 'a', requestId: ask.requestId,
      answers: { qq1: ['Question cards only'] },
    });

    sendFromHost({ t: 'session-patch', id: 'a',
      patch: { op: 'replace', item: { ...ask, state: 'answered', answers: { qq1: ['Question cards only'] } } },
    });
    within(region).getByRole('button', { name: 'Allow Write' });
    screen.getByText('Question — Answered');
  });

  test('does not pin stale prompts restored without live requests', () => {
    renderApp();
    hydrate([permission(), question()]);
    assert.strictEqual(screen.queryByRole('region', { name: 'Pending prompts' }) === null, true);
    screen.getByText('Write — no longer awaiting a response');
  });

  test('pins a nested question and falls back when the selected request settles', async () => {
    renderApp();
    const ask = question({ requestId: 'question-r', ts: 2 });
    const approval = permission({ id: 'p1', requestId: 'permission-r', ts: 1 });
    hydrate([approval, tool({ id: 'agent1', children: [ask] })], {
      pending: [{ requestId: approval.requestId, tool: approval.tool }],
      pendingQuestions: [{ requestId: ask.requestId, blocking: true, questions: ask.questions }],
    });
    const region = screen.getByRole('region', { name: 'Pending prompts' });
    await userEvent.click(within(region).getByRole('button', { name: 'Next prompt' }));
    within(region).getByRole('radiogroup', { name: 'Which one?' });
    sendFromHost({ t: 'session-patch', id: 'a',
      patch: { op: 'replace', parentItemId: 'agent1', item: { ...ask, state: 'cancelled' } },
    });
    within(region).getByRole('button', { name: 'Allow Write' });
    assert.strictEqual(within(region).queryByRole('button', { name: 'Next prompt' }) === null, true);
  });
});

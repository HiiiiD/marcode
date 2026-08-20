import * as assert from 'assert';
import type { Attachment } from '../../protocol/messages';
import { makeSession } from './agent-session.test';

function att(id: string, over: Partial<Attachment> = {}): Attachment {
  return { id, path: `/tmp/${id}.png`, name: `${id}.png`, kind: 'image', mediaType: 'image/png', bytes: 4, ...over };
}

async function settle() {
  for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); }
}

suite('AgentSession attachments', () => {
  test('added attachments show up as pending', async () => {
    const { session } = await makeSession();
    session.addAttachments([att('a1')]);
    assert.deepStrictEqual(session.pendingAttachments.map((a) => a.id), ['a1']);
  });

  test('removeAttachment drops one by id', async () => {
    const { session } = await makeSession();
    session.addAttachments([att('a1'), att('a2')]);
    session.removeAttachment('a1');
    assert.deepStrictEqual(session.pendingAttachments.map((a) => a.id), ['a2']);
  });

  test('addAttachments refuses past the pending cap', async () => {
    const { session } = await makeSession();
    session.addAttachments(Array.from({ length: 10 }, (_, i) => att(`a${i}`)));
    session.addAttachments([att('overflow')]);
    assert.strictEqual(session.pendingAttachments.length, 10);
    assert.strictEqual(session.pendingAttachments.some((a) => a.id === 'overflow'), false);
  });

  test('send drains the pending set onto the transcript item and the run', async () => {
    const { session, run } = await makeSession();
    session.addAttachments([att('a1')]);

    session.send('look at this');

    assert.strictEqual(session.pendingAttachments.length, 0);
    const snap = await session.snapshot();
    const last = snap.items.at(-1);
    assert.strictEqual(last?.role, 'user');
    assert.deepStrictEqual(
      last?.role === 'user' ? last.attachments?.map((a) => a.id) : undefined,
      ['a1'],
    );
    // The fake run records every (text, context, attachments) triple it was sent.
    assert.deepStrictEqual(run.sent.at(-1)?.attachments?.map((a) => a.id), ['a1']);
  });

  test('a send reports the drained set up, so the composer stops showing it', async () => {
    // The whole point: `sessions-changed` carries no attachments, so without
    // this report the chips of a spent set stay in the composer, with live
    // removal controls, describing a list the host no longer holds.
    const { session, sink } = await makeSession();
    session.addAttachments([att('a1')]);

    session.send('look at this');

    assert.deepStrictEqual(sink.attachmentSets.at(-1), []);
  });

  test('a send with nothing pending reports nothing — an empty set did not change', async () => {
    const { session, sink } = await makeSession();
    const before = sink.attachmentSets.length;
    session.send('plain');
    assert.strictEqual(sink.attachmentSets.length, before);
  });

  test('a send with nothing pending carries no attachments field', async () => {
    const { session } = await makeSession();
    session.send('plain');
    const snap = await session.snapshot();
    const last = snap.items.at(-1);
    assert.strictEqual(last?.role === 'user' && last.attachments === undefined, true);
  });

  test('an attachment pending at queue time rides the queued message', async () => {
    const { session, run } = await makeSession();
    session.send('first');
    await settle();
    assert.strictEqual(session.state.status, 'running', 'the turn is still in flight');

    session.addAttachments([att('a1')]);
    session.send('second');

    // Captured into the queued entry immediately, not left on the live set.
    assert.strictEqual(session.pendingAttachments.length, 0);
    assert.deepStrictEqual(session.state.queued?.[0]?.attachments?.map((a) => a.id), ['a1']);

    run.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    const snap = await session.snapshot();
    const second = snap.items.filter((i) => i.role === 'user').at(-1);
    assert.deepStrictEqual(
      second?.role === 'user' ? second.attachments?.map((a) => a.id) : undefined,
      ['a1'],
    );
    assert.deepStrictEqual(run.sent.at(-1)?.attachments?.map((a) => a.id), ['a1']);
  });

  test('an attachment added after queueing stays pending for the next turn, not the queued one', async () => {
    const { session, run } = await makeSession();
    session.send('first');
    await settle();

    session.send('second');
    // Nothing was pending at queue time.
    assert.strictEqual(session.state.queued?.[0]?.attachments, undefined);

    session.addAttachments([att('a2')]);
    // Still pending: it must not retroactively attach to the already-queued message.
    assert.deepStrictEqual(session.pendingAttachments.map((a) => a.id), ['a2']);

    run.runs[0].emit({ kind: 'turn-end', reason: 'done' });
    await settle();

    const snap = await session.snapshot();
    const second = snap.items.filter((i) => i.role === 'user').at(-1);
    assert.strictEqual(second?.role === 'user' && second.attachments === undefined, true);
    assert.deepStrictEqual(run.sent.at(-1)?.attachments, undefined);
    // Left for the next turn to drain.
    assert.deepStrictEqual(session.pendingAttachments.map((a) => a.id), ['a2']);
  });
});

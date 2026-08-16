import * as assert from 'assert';
import type { Attachment } from '../../protocol/messages';
import { makeSession } from './agent-session.test';

function att(id: string, over: Partial<Attachment> = {}): Attachment {
  return { id, path: `/tmp/${id}.png`, name: `${id}.png`, kind: 'image', mediaType: 'image/png', bytes: 4, ...over };
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

  test('a send with nothing pending carries no attachments field', async () => {
    const { session } = await makeSession();
    session.send('plain');
    const snap = await session.snapshot();
    const last = snap.items.at(-1);
    assert.strictEqual(last?.role === 'user' && last.attachments === undefined, true);
  });
});

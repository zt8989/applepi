import { createDataStreamResponse } from 'ai';
import { PERMISSION_LEVELS, PERMISSION_SCRATCH_KEY, runLoopStreamSegment } from '@applepi/core';
import { bindSession, buildTurnMessages, getHarness, getModel } from '@/lib/server';
import type { ChatRequestBody } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat — segment 1 of a turn: stream the loop until it finishes or
 * pauses at a tool call that requires approval. The session id (new or
 * resumed) is announced via a `session` data part so the client can persist it.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as ChatRequestBody;
  if (!body.workspace || !body.messageId || !body.message) {
    return new Response('missing workspace/messageId/message', { status: 400 });
  }
  const harness = getHarness(body.workspace);
  const store = await bindSession(harness, body.workspace, body.sessionId);

  // A brand-new session may carry a pre-chosen permission level (picked in
  // the composer footer before the first message): persist it like /level.
  if (!body.sessionId && body.level && (PERMISSION_LEVELS as readonly string[]).includes(body.level as any)) {
    harness.session.scratch[PERMISSION_SCRATCH_KEY] = body.level;
    await store.appendEvent('level/set', { level: body.level });
    await harness.emit('system_prompt/permission', { level: body.level });
  }

  const messages = await buildTurnMessages(harness);
  messages.push({ role: 'user', content: body.message });
  await store.appendMessage('user', body.message);

  const model = await getModel();
  return createDataStreamResponse({
    async execute(writer) {
      writer.writeData({ type: 'session', sessionId: store.sessionId });
      await runLoopStreamSegment(harness, messages, {
        model,
        store,
        writer,
        messageId: body.messageId,
      });
    },
    onError: (e) => `chat error: ${(e as Error)?.message ?? String(e)}`,
  });
}

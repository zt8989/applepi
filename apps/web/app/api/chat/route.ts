import { createDataStreamResponse } from 'ai';
import {
  PERMISSION_LEVELS,
  PERMISSION_SCRATCH_KEY,
  REASONING_LEVELS,
  resolveLlmConfig,
  runLoopStreamSegment,
  type ReasoningLevel,
} from '@applepi/core';
import {
  bindSession,
  buildTurnMessages,
  getHarness,
  getModel,
  sessionReasoningLevel,
} from '@/lib/server';
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

  // Reasoning level: a brand-new session may carry a pre-chosen level (picked
  // in the composer before the first message) → persist as `reasoning/set`;
  // otherwise resolve session override ?? global default.
  let reasoningLevel: ReasoningLevel;
  const preChosen =
    !body.sessionId && body.reasoning && (REASONING_LEVELS as readonly string[]).includes(body.reasoning)
      ? (body.reasoning as ReasoningLevel)
      : undefined;
  if (preChosen) {
    await store.appendEvent('reasoning/set', { level: preChosen });
    reasoningLevel = preChosen;
  } else {
    const sessionId = body.sessionId ?? store.sessionId;
    reasoningLevel = sessionId
      ? await sessionReasoningLevel(body.workspace, sessionId)
      : ((await resolveLlmConfig()).reasoningLevel);
  }

  const messages = await buildTurnMessages(harness);
  messages.push({ role: 'user', content: body.message });
  await store.appendMessage('user', body.message);

  const model = await getModel();
  const { protocol } = await resolveLlmConfig();
  return createDataStreamResponse({
    async execute(writer) {
      writer.writeData({ type: 'session', sessionId: store.sessionId });
      await runLoopStreamSegment(harness, messages, {
        model,
        store,
        writer,
        messageId: body.messageId,
        protocol,
        reasoningLevel,
      });
    },
    onError: (e) => `chat error: ${(e as Error)?.message ?? String(e)}`,
  });
}

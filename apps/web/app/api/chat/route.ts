import { createDataStreamResponse } from 'ai';
import {
  PERMISSION_LEVELS,
  REASONING_LEVELS,
  applyPermissionLevel,
  resolveLlmConfig,
  runLoopStreamSegment,
  type ReasoningLevel,
} from '@applepi/core';
import {
  bindSession,
  buildSystemPrompt,
  buildTurnMessages,
  getHarness,
  getModel,
  sessionMode,
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
  // Mode (ADR-0015): chosen ONCE at session creation — a new session takes the
  // body's `mode` (default standard); a resumed session re-reads the recorded
  // `mode` event and rebuilds the matching spec (tools are immutable per mode).
  const isNew = !body.sessionId;
  const mode = isNew ? (body.mode === 'base' ? 'base' : 'standard') : await sessionMode(body.workspace, body.sessionId!);
  const harness = getHarness(body.workspace, mode);
  const store = await bindSession(harness, body.workspace, body.sessionId, mode);

  // A brand-new session may carry a pre-chosen permission level (picked in
  // the composer footer before the first message): the flat prompt re-reads
  // the level each turn, so no rebuild event is needed (ADR-0015).
  if (isNew && body.level && (PERMISSION_LEVELS as readonly string[]).includes(body.level as any)) {
    await applyPermissionLevel(harness.session, store, body.level);
  }

  // Reasoning level: a brand-new session may carry a pre-chosen level (picked
  // in the composer before the first message) → persist as a session-config
  // override; otherwise resolve via the cascade (override ?? general ?? medium).
  let reasoningLevel: ReasoningLevel;
  const preChosen =
    isNew && body.reasoning && (REASONING_LEVELS as readonly string[]).includes(body.reasoning)
      ? (body.reasoning as ReasoningLevel)
      : undefined;
  if (preChosen) {
    const overrides = await store.loadConfig();
    await store.saveConfig({ ...overrides, reasoningLevel: preChosen });
    reasoningLevel = preChosen;
  } else {
    const sessionId = body.sessionId ?? store.sessionId;
    reasoningLevel = sessionId
      ? await sessionReasoningLevel(body.workspace, sessionId)
      : ((await resolveLlmConfig()).reasoningLevel);
  }

  // A brand-new session persists its initial flat system prompt once, AFTER
  // the pre-chosen level/reasoning so the replay record matches the first turn.
  if (isNew) {
    await store.appendMessage('system', buildSystemPrompt(harness));
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

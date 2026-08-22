import { createDataStreamResponse } from 'ai';
import {
  PERMISSION_LEVELS,
  REASONING_LEVELS,
  applyPermissionLevel,
  runLoopStreamSegment,
  type ReasoningLevel,
  type StreamLoopOpts,
} from '@applepi/core';
import {
  bindSession,
  buildSystemPrompt,
  buildTurnMessages,
  getHarness,
  sessionMode,
  sessionReasoningLevel,
} from '../server.js';
import { resolveSeam, type ChatSeam } from './seam.js';

/**
 * POST /api/chat — segment 1 of a turn: stream the loop until it finishes or
 * pauses at a tool call that requires approval. The session id (new or
 * resumed) is announced via a `session` data part so the client can persist it.
 * `seam` injects a model + streamText for request-level tests (ADR-0017 §8);
 * production callers omit it and the real provider config is resolved.
 */
export async function handleChat(req: Request, seam?: ChatSeam): Promise<Response> {
  const body = (await req.json()) as {
    workspace: string;
    sessionId?: string;
    messageId: string;
    message: string;
    level?: string;
    reasoning?: string;
    mode?: string;
  };
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
    // bindSession always assigns a session id (create/new or resume), so the
    // cascade resolution always has a session — no config-registry fallback.
    reasoningLevel = await sessionReasoningLevel(body.workspace, body.sessionId ?? store.sessionId!);
  }

  // A brand-new session persists its initial flat system prompt once, AFTER
  // the pre-chosen level/reasoning so the replay record matches the first turn.
  if (isNew) {
    await store.appendMessage('system', buildSystemPrompt(harness));
  }

  const messages = await buildTurnMessages(harness);
  messages.push({ role: 'user', content: body.message });
  await store.appendMessage('user', body.message);

  // The model/protocol come from the seam or the real cascade; the reasoning
  // level is resolved above (pre-chosen override or the session cascade).
  const { model, protocol } = await resolveSeam(seam, body.workspace, store.sessionId!);
  return createDataStreamResponse({
    async execute(writer) {
      writer.writeData({ type: 'session', sessionId: store.sessionId });
      const opts: StreamLoopOpts = {
        model,
        store,
        writer,
        messageId: body.messageId,
        protocol,
        reasoningLevel,
      };
      // Conditional assignment (a conditional spread of the generic streamText
      // type defeats TS unification).
      if (seam?.streamTextCall) opts.streamTextCall = seam.streamTextCall;
      await runLoopStreamSegment(harness, messages, opts);
    },
    onError: (e) => `chat error: ${(e as Error)?.message ?? String(e)}`,
  });
}
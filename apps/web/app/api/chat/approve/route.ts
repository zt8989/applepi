import { createDataStreamResponse } from 'ai';
import {
  executeApprovedTool,
  pendingToolCalls,
  resolveLlmConfig,
  runLoopStreamSegment,
} from '@applepi/core';
import {
  bindSession,
  buildTurnMessages,
  getHarness,
  getSessionModel,
  sessionMode,
  sessionReasoningLevel,
} from '@/lib/server';
import type { ApproveRequestBody } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/chat/approve — resume a paused turn (ADR-0011, pause/resume
 * protocol): execute (approve) or skip (deny) the pending tool call, stream
 * its result, then either pause at the next pending tool call or continue the
 * loop. No LLM call is repeated — the jsonl message log is the loop state.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as ApproveRequestBody;
  if (!body.workspace || !body.sessionId || !body.toolCallId || !body.messageId) {
    return new Response('missing fields', { status: 400 });
  }
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    return new Response('decision must be approve|deny', { status: 400 });
  }

  const mode = await sessionMode(body.workspace, body.sessionId);
  const harness = getHarness(body.workspace, mode);
  const store = await bindSession(harness, body.workspace, body.sessionId, mode);

  const pending = await store.lastEvent('tool/approval-pending');
  if (!pending) {
    return new Response('no pending approval for this session', { status: 400 });
  }
  if (pending.payload?.decision) {
    return new Response('approval already resolved', { status: 400 });
  }
  if (pending.payload?.toolCallId !== body.toolCallId) {
    return new Response('pending tool call mismatch', { status: 400 });
  }

  const messages = await buildTurnMessages(harness);
  const { model, protocol } = await getSessionModel(body.workspace, body.sessionId);
  const reasoningLevel = await sessionReasoningLevel(body.workspace, body.sessionId);

  return createDataStreamResponse({
    async execute(writer) {
      // Persist the decision; the client derives pending state from parts.
      await store.appendEvent('tool/approval-pending', {
        ...pending.payload,
        decision: body.decision,
      });

      const target = pendingToolCalls(messages).find((t) => t.toolCallId === body.toolCallId);
      if (!target) {
        throw new Error(`tool call ${body.toolCallId} not found in session history`);
      }
      await executeApprovedTool(harness, messages, target, body.decision, { store, writer }, undefined, body.answer);

      const remaining = pendingToolCalls(messages);
      if (remaining.length > 0) {
        const next = remaining[0];
        const nextExpectsAnswer = harness.getTool(next.toolName)?.expectsAnswer === true;
        await store.appendEvent('tool/approval-pending', {
          ...next,
          expectsAnswer: nextExpectsAnswer,
        });
        writer.writeData({
          type: 'approval-pending',
          toolCallId: next.toolCallId,
          toolName: next.toolName,
          args: next.args,
          expectsAnswer: nextExpectsAnswer,
        });
        return;
      }
      await runLoopStreamSegment(harness, messages, {
        model,
        store,
        writer,
        messageId: body.messageId,
        protocol,
        reasoningLevel,
      });
    },
    onError: (e) => `approve error: ${(e as Error)?.message ?? String(e)}`,
  });
}

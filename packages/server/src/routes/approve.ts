import { createDataStreamResponse } from 'ai';
import {
  executeApprovedTool,
  pendingToolCalls,
  runLoopStreamSegment,
  type StreamLoopOpts,
} from '@applepi/core';
import {
  bindSession,
  buildTurnMessages,
  getHarness,
  sessionMode,
} from '../server.js';
import { resolveSeam, type ChatSeam } from './seam.js';

/**
 * POST /api/chat/approve — resume a paused turn (ADR-0011, pause/resume
 * protocol): execute (approve) or skip (deny) the pending tool call, stream
 * its result, then either pause at the next pending tool call or continue the
 * loop. No LLM call is repeated — the jsonl message log is the loop state.
 * `seam` injects a model + streamText for request-level tests (ADR-0017 §8).
 */
export async function handleChatApprove(req: Request, seam?: ChatSeam): Promise<Response> {
  const body = (await req.json()) as {
    workspace: string;
    sessionId: string;
    messageId: string;
    toolCallId: string;
    decision: 'approve' | 'deny';
    answer?: string;
  };
  if (!body.workspace || !body.sessionId || !body.toolCallId || !body.messageId) {
    return new Response('missing fields', { status: 400 });
  }
  if (body.decision !== 'approve' && body.decision !== 'deny') {
    return new Response('decision must be approve|deny', { status: 400 });
  }

  const mode = await sessionMode(body.workspace, body.sessionId);
  const harness = getHarness(body.workspace, mode);
  const store = await bindSession(harness, body.workspace, body.sessionId, mode);

  const pending = await store.pendingToolCall();
  if (!pending) {
    return new Response('no pending approval for this session', { status: 400 });
  }
  if (pending.toolCallId !== body.toolCallId) {
    return new Response('pending tool call mismatch', { status: 400 });
  }

  const messages = await buildTurnMessages(harness);
  const { model, protocol, reasoningLevel } = await resolveSeam(seam, body.workspace, body.sessionId);

  return createDataStreamResponse({
    async execute(writer) {
      // The decision closes the tool_call interval (written by
      // executeApprovedTool); the client derives pending state from parts.
      const target = pendingToolCalls(messages).find((t) => t.toolCallId === body.toolCallId);
      if (!target) {
        throw new Error(`tool call ${body.toolCallId} not found in session history`);
      }
      await executeApprovedTool(harness, messages, target, body.decision as 'approve' | 'deny', { store, writer }, undefined, body.answer);

      const remaining = pendingToolCalls(messages);
      if (remaining.length > 0) {
        const next = remaining[0];
        const nextExpectsAnswer = harness.getTool(next.toolName)?.expectsAnswer === true;
        // No store write: the next open tool_call interval already IS the
        // pending state (ADR-0018); only the client-facing part is streamed.
        writer.writeData({
          type: 'approval-pending',
          toolCallId: next.toolCallId,
          toolName: next.toolName,
          args: next.args,
          expectsAnswer: nextExpectsAnswer,
        });
        return;
      }
      const opts: StreamLoopOpts = {
        model,
        store,
        writer,
        messageId: body.messageId,
        protocol,
        reasoningLevel,
      };
      if (seam?.streamTextCall) opts.streamTextCall = seam.streamTextCall;
      await runLoopStreamSegment(harness, messages, opts);
    },
    onError: (e) => `approve error: ${(e as Error)?.message ?? String(e)}`,
  });
}
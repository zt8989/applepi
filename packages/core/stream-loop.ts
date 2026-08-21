import { formatDataStreamPart, type DataStreamWriter } from 'ai';
import type { Harness } from './harness.js';
import type { SessionStore } from './session.js';
import type { ApprovalMode } from './types.js';
import { getTracer, modelLabel, type Tracer, type TraceHandle } from './trace.js';
import type { ProviderProtocol, ReasoningLevel } from './config.js';

/**
 * The streaming `loop` deep module (ADR-0015) + approval state machine
 * (ADR-0011).
 *
 * The web interface drives the harness over short-lived, segmented streams:
 *   - `runLoopStreamSegment` runs the agent loop (streamText, token-level)
 *     until it either finishes or hits a tool call classified `ask`, at which
 *     point it PAUSES: the pending approval is persisted as a session event
 *     and the stream ends. No LLM call is repeated on resume — the jsonl
 *     message log IS the loop state.
 *   - `executeApprovedTool` resumes a paused call (approve = run it through
 *     the tool seam, `harness.executeTool`; deny = feed a refusal back to the
 *     model) and streams the tool-result part.
 *
 * Read-classified (`auto`) tools execute inline and their results stream in
 * the same segment. (The CLI's non-streaming `runLoop` was removed with the
 * CLI — this streaming loop is the only agent loop.)
 */

export interface PendingApproval {
  toolCallId: string;
  toolName: string;
  args: any;
  decision?: 'approve' | 'deny';
}

export interface StreamLoopOpts {
  model: any;
  store: SessionStore | null;
  writer: DataStreamWriter;
  maxTurns?: number;
  /**
   * Stable message id reused across segments (and across HTTP requests) so the
   * client merges all parts of one user turn into a single assistant message.
   */
  messageId: string;
  /** Provider protocol — selects how `reasoningLevel` maps to request params. */
  protocol?: ProviderProtocol;
  /** Effective reasoning level for this run (session override ?? global default). */
  reasoningLevel?: ReasoningLevel;
  /** Persist/emit a pending approval. Default: `tool/approval-pending` event. */
  onPending?: (p: PendingApproval) => void | Promise<void>;
  /** Test seam: the streamText call used per LLM turn. */
  streamTextCall?: typeof import('ai').streamText;
  /** Override the Langfuse tracer (defaults to the env-configured one). */
  trace?: Tracer | null;
}

export type StreamFinishReason = 'stop' | 'tool-calls' | 'max-turns' | 'error';

export interface StreamSegmentResult {
  finishReason: StreamFinishReason;
  error?: string;
}

/** Resolve a tool's approval mode (ToolSpec.approval; default `ask`). */
export async function classifyApproval(
  harness: Harness,
  toolName: string,
  args: any,
): Promise<ApprovalMode> {
  const spec = harness.getTool(toolName);
  const a = spec?.approval;
  if (typeof a === 'function') return await a(args);
  return a ?? 'ask';
}

/** Tool calls in the LAST assistant message that still lack a tool result. */
export function pendingToolCalls(messages: any[]): PendingApproval[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const calls = (m.content ?? []).filter((p: any) => p?.type === 'tool-call');
    if (calls.length === 0) return [];
    const done = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      for (const p of messages[j]?.content ?? []) {
        if (p?.type === 'tool-result') done.add(p.toolCallId);
      }
    }
    return calls
      .filter((c: any) => !done.has(c.toolCallId))
      .map((c: any) => ({ toolCallId: c.toolCallId, toolName: c.toolName, args: c.args }));
  }
  return [];
}

async function defaultPendingWriter(store: SessionStore | null, p: PendingApproval): Promise<void> {
  await store?.appendEvent('tool/approval-pending', p);
}

function streamToolResult(writer: DataStreamWriter, toolCallId: string, result: string): void {
  writer.write(formatDataStreamPart('tool_result', { toolCallId, result }));
}

/**
 * Run one segment of the streaming loop from `messages` (conversation turns
 * only; the system prompt is rebuilt by the caller). Executes `auto` tools
 * inline; pauses at the first `ask` tool call, streaming a `approval-pending`
 * data part so the client can render the approval card.
 */
export async function runLoopStreamSegment(
  harness: Harness,
  messages: any[],
  opts: StreamLoopOpts,
): Promise<StreamSegmentResult> {
  const maxTurns = opts.maxTurns ?? 8;
  const tracer = opts.trace !== undefined ? opts.trace : await getTracer();
  const traceHandle = tracer?.session('agent-turn', opts.store?.sessionId ?? harness.workspace, {
    input: [...messages].reverse().find((m: any) => m?.role === 'user')?.content,
  });
  let turn = 0;
  try {
    while (turn < maxTurns) {
      turn++;

      const { result, ctx } = await harness.llm.stream({
        model: opts.model,
        messages,
        messageId: opts.messageId,
        protocol: opts.protocol,
        reasoningLevel: opts.reasoningLevel,
        streamTextCall: opts.streamTextCall,
      });
      const r: any = result;
      const gen = traceHandle?.generation('llm', { messages: ctx.messages }, { model: modelLabel(opts.model) });
      r.mergeIntoDataStream(opts.writer, {
        sendUsage: true,
        sendReasoning: true,
      });
      // Await stream completion (mergeIntoDataStream is async). `text`,
      // `usage` and `toolCalls` are Promises on a StreamTextResult. `reasoning`
      // carries the full concatenated thinking text (streamed live to the
      // client as reasoning parts; captured here for persistence).
      const text = (await r.text) as string;
      const usage = await r.usage;
      const reasoning = (await r.reasoning) as string | undefined;
      gen?.end(text, usage);

      const toolCalls: any[] = (await r.toolCalls) ?? [];
      const assistantParts: any[] = [];
      if (reasoning && reasoning.trim()) assistantParts.push({ type: 'reasoning', text: reasoning });
      if (text) assistantParts.push({ type: 'text', text });
      for (const tc of toolCalls) {
        assistantParts.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          args: tc.args,
        });
      }
      if (assistantParts.length > 0) {
        messages.push({ role: 'assistant', content: assistantParts });
        await opts.store?.appendMessage('assistant', assistantParts);
      }

      if (toolCalls.length === 0) return { finishReason: 'stop' };

      for (const tc of toolCalls) {
        const mode = await classifyApproval(harness, tc.toolName, tc.args);
        if (mode === 'ask') {
          const pending: PendingApproval = {
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          };
          await (opts.onPending ?? ((p) => defaultPendingWriter(opts.store, p)))(pending);
          opts.writer.writeData({
            type: 'approval-pending',
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            args: pending.args,
          });
          return { finishReason: 'tool-calls' };
        }
        await executeApprovedTool(harness, messages, tc, 'approve', opts, traceHandle);
      }
      // All tools executed inline -> next LLM turn.
    }
    return { finishReason: 'max-turns' };
  } catch (e: any) {
    // Surface errors to the caller: the web route's onError turns this into an
    // error part the client can display, instead of a silently-truncated stream.
    throw new Error(`runLoopStreamSegment failed: ${e?.message ?? String(e)}`);
  }
}

/**
 * Execute (approve) or skip (deny) one pending tool call, streaming its
 * tool-result part and appending the tool message to `messages` + store.
 * Deny feeds a refusal back to the model (ADR-0011 Q12=A1), mirroring the
 * CLI's blocked-tool error semantics.
 */
export async function executeApprovedTool(
  harness: Harness,
  messages: any[],
  tc: { toolCallId: string; toolName: string; args: any },
  decision: 'approve' | 'deny',
  opts: { store: SessionStore | null; writer: DataStreamWriter },
  traceHandle?: TraceHandle | null,
): Promise<void> {
  const span = traceHandle?.span('tool', { name: tc.toolName, args: tc.args, decision });
  let res: string;
  if (decision === 'deny') {
    res = `[user denied] tool ${tc.toolName} was NOT executed (the user rejected this tool call).`;
  } else {
    const tctx: any = {
      session: harness.session,
      state: {},
      toolName: tc.toolName,
      toolArgs: tc.args,
    };
    // Security seam (ADR-0015): the ctx carries the current level; the tool
    // self-determines. No onion stack.
    await harness.executeTool(tctx);
    res = tctx.toolResult ?? '';
  }
  span?.end({ result: res });
  streamToolResult(opts.writer, tc.toolCallId, res);
  const toolMsg = { role: 'tool', content: [{ type: 'tool-result', toolCallId: tc.toolCallId, toolName: tc.toolName, result: res }] };
  messages.push(toolMsg);
  await opts.store?.appendMessage('tool', toolMsg.content);
}

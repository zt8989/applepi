import type { Harness } from './harness.js';
import { getTracer, modelLabel, type Tracer, type TraceHandle } from './trace.js';
import type { LlmCall } from './llm.js';
import type { Ctx } from './types.js';

/**
 * The `loop` deep module (ADR-0015): drives the multi-turn orchestration —
 * user input → call the LLM (via the `llm` module) → execute tool calls
 * through the `tool` seam → feed results back → repeat until the model stops
 * calling tools or maxTurns is reached — including pause / approval / resume
 * (see `stream-loop.ts`). It depends on the `llm` module for the model call
 * and knows no AI-SDK detail.
 *
 * We run our own execution (not the AI SDK's) so the tool seam (the security
 * seam: a level-carrying ctx handed to `harness.executeTool`) wraps every
 * tool call.
 */

export interface LoopOpts {
  model: any;
  maxTurns?: number;
  /**
   * Injectable LLM call. Defaults to Vercel AI SDK `generateText`. Swapping it
   * lets tests drive the loop without a real provider/API key.
   */
  llmCall?: LlmCall;
  /** Called after each assistant/tool message is appended (used for persistence). */
  onMessage?: (role: string, content: any) => void | Promise<void>;
  /** Override the Langfuse tracer (defaults to the env-configured one). */
  trace?: Tracer | null;
}

export { type LlmCall } from './llm.js';

/**
 * The agent loop: call the LLM, collect tool calls, execute each through the
 * tool seam (`harness.executeTool`, ADR-0015), feed results back, repeat until
 * the model stops calling tools or maxTurns is reached.
 */
export async function runLoop(
  harness: Harness,
  messages: any[],
  opts: LoopOpts,
): Promise<any[]> {
  const maxTurns = opts.maxTurns ?? 8;
  const tracer = opts.trace !== undefined ? opts.trace : await getTracer();
  const traceHandle = tracer?.session('agent-turn', harness.sessionStore?.sessionId ?? harness.workspace, {
    input: [...messages].reverse().find((m: any) => m?.role === 'user')?.content,
  });
  let turn = 0;
  while (turn < maxTurns) {
    turn++;

    const { result, ctx } = await harness.llm.generate({
      model: opts.model,
      messages,
      llmCall: opts.llmCall,
    });
    const r: any = result;
    const gen = traceHandle?.generation('llm', { messages: ctx.messages }, { model: modelLabel(opts.model) });
    gen?.end(r?.text ?? '', r?.usage);

    const toolCalls: any[] = r?.toolCalls ?? [];
    const assistantParts: any[] = [];
    if (r?.text) assistantParts.push({ type: 'text', text: r.text });
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
      await opts.onMessage?.('assistant', assistantParts);
    }

    if (toolCalls.length === 0) break;

    const toolMessages: any[] = [];
    for (const tc of toolCalls) {
      const span = traceHandle?.span('tool', { name: tc.toolName, args: tc.args });
      const tctx: Ctx = {
        session: harness.session,
        state: {},
        toolName: tc.toolName,
        toolArgs: tc.args,
      };
      // Security seam (ADR-0015): the ctx carries the current level via
      // session.scratch; the tool self-determines. No onion stack.
      await harness.executeTool(tctx);
      const res = tctx.toolResult ?? '';
      span?.end({ result: res });
      toolMessages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: res,
          },
        ],
      });
    }
    messages.push(...toolMessages);
    for (const tm of toolMessages) await opts.onMessage?.('tool', tm.content);
  }
  return messages;
}

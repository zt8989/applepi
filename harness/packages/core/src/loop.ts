import { generateText } from 'ai';
import type { Harness } from './harness.js';

export interface LoopOpts {
  model: any;
  maxTurns?: number;
}

/**
 * The agent loop: call the LLM, collect tool calls, execute each through the
 * `tool` onion stack, feed results back, repeat until the model stops calling
 * tools or maxTurns is reached. We run our own execution (not the AI SDK's)
 * so the denylist / hook middleware wrap every tool call.
 */
export async function runLoop(
  harness: Harness,
  messages: any[],
  opts: LoopOpts,
): Promise<any[]> {
  const maxTurns = opts.maxTurns ?? 8;
  let turn = 0;
  while (turn < maxTurns) {
    turn++;
    const toolDefs = harness.buildToolDefs();

    const llmCtx: any = { session: harness.session, state: {}, messages };
    let result: any;
    await harness.bus.run('llm', llmCtx, async () => {
      result = await generateText({
        model: opts.model,
        messages: llmCtx.messages,
        // no `execute`: SDK returns toolCalls, we run them ourselves
        tools: toolDefs as any,
      });
    });
    const r: any = result;

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
    }

    if (toolCalls.length === 0) break;

    const toolMessages: any[] = [];
    for (const tc of toolCalls) {
      const tctx: any = {
        session: harness.session,
        state: {},
        toolName: tc.toolName,
        toolArgs: tc.args,
      };
      await harness.bus.run('tool', tctx, async () => {
        await harness.executeTool(tctx);
      });
      let res = tctx.toolResult ?? '';
      if (tctx.state?.__vetoed && !res) res = 'BLOCKED: vetoed by middleware';
      if (tctx.error) {
        res = `ERROR: ${(tctx.error as Error)?.message ?? String(tctx.error)}`;
      }
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
  }
  return messages;
}

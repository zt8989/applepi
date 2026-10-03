/**
 * Effects —— reducer 返回的 Cmd 在这里构造，副作用在这里执行。
 *
 * 与 redux-loop 的 Cmd.run 契约一致：
 * - args 里的 Cmd.dispatch / Cmd.getState 两个符号由 redux-loop 换成真的 dispatch/getState；
 * - 执行过程中可以随时 dispatch（流式增量就是这样回流的）；
 * - resolve 的值交给 successActionCreator 变成 action；
 * - reject 的错误交给 failActionCreator。
 */
import { Cmd, type CmdType } from 'redux-loop';
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  ToolCall,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { AgentAction } from './actions';
import type { AgentState } from './state';
import { getTool, getTools } from './tools';
import { beginRun, endRun } from './run-control';
import { resolveApiKey, type StreamFn } from './provider';

/** 副作用依赖：模型与 streamFn 由 store 装配时注入。 */
export interface EffectDeps {
  streamFn: StreamFn;
  model: Model<any>;
}

let deps: EffectDeps | null = null;

export function setEffectDeps(next: EffectDeps): void {
  deps = next;
}

export function clearEffectDeps(): void {
  deps = null;
}

function requireDeps(): EffectDeps {
  if (!deps) throw new Error('EffectDeps 未初始化：先调用 setEffectDeps()');
  return deps;
}

/** 交给 LLM 的工具描述（去掉 execute，只留 schema）。 */
function toolSchemas(): Tool[] {
  return getTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

// ─── LLM 调用 ───

/**
 * 一次 LLM 流式调用：增量回流 action，最终 AssistantMessage 交给 successActionCreator。
 */
async function callLlm(
  dispatch: Cmd.Dispatch,
  getState: Cmd.GetState,
): Promise<AssistantMessage> {
  const { streamFn, model } = requireDeps();
  const state = getState<AgentState>();
  const context: Context = {
    systemPrompt: state.systemPrompt,
    messages: state.messages,
    tools: toolSchemas(),
  };

  const controller = beginRun();
  try {
    const apiKey = resolveApiKey(model.provider);
    const options: SimpleStreamOptions = { signal: controller.signal };
    if (apiKey !== undefined) options.apiKey = apiKey;
    const stream = streamFn(model, context, options);
    let final: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === 'text_delta' && event.delta) {
        dispatch({ type: 'llm/delta', delta: event.delta });
      } else if (event.type === 'thinking_delta' && event.delta) {
        dispatch({ type: 'llm/thinking', delta: event.delta });
      } else if (event.type === 'done') {
        final = event.message;
      } else if (event.type === 'error') {
        final = event.error;
      }
    }
    if (!final) throw new Error('LLM 流在发出 done/error 之前就结束了');
    if (final.stopReason === 'error') {
      throw new Error(final.errorMessage || 'LLM 返回错误');
    }
    return final;
  } finally {
    endRun();
  }
}

/** 构造「调一次 LLM」的 Cmd。 */
export function callLlmCmd(): CmdType {
  return Cmd.run(callLlm, {
    args: [Cmd.dispatch, Cmd.getState],
    successActionCreator: (message: AssistantMessage): AgentAction => ({
      type: 'llm/done',
      message,
    }),
    failActionCreator: (error: unknown): AgentAction => ({
      type: 'llm/failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  });
}

// ─── 工具执行 ───

function toToolResultMessage(
  call: ToolCall,
  content: ToolResultMessage['content'],
  details: unknown,
  isError: boolean,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content,
    details,
    isError,
    timestamp: Date.now(),
  };
}

async function executeToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
  const tool = getTool(call.name);
  if (!tool) {
    return toToolResultMessage(
      call,
      [{ type: 'text', text: `未知工具：${call.name}` }],
      null,
      true,
    );
  }
  try {
    const result = await tool.execute(call.id, call.arguments ?? {}, signal);
    return toToolResultMessage(call, result.content, result.details, false);
  } catch (error) {
    return toToolResultMessage(
      call,
      [
        {
          type: 'text',
          text: `工具 ${call.name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      null,
      true,
    );
  }
}

/**
 * 执行一批工具调用（并行）：每个先回流 tool/start，完成回流 tool/result。
 */
async function executeToolCalls(
  dispatch: Cmd.Dispatch,
  _getState: Cmd.GetState,
  toolCalls: ToolCall[],
): Promise<number> {
  const controller = beginRun();
  try {
    const results = await Promise.all(
      toolCalls.map(async (call) => {
        dispatch({ type: 'tool/start', call });
        const message = await executeToolCall(call, controller.signal);
        dispatch({ type: 'tool/result', message });
        return message;
      }),
    );
    return results.length;
  } finally {
    endRun();
  }
}

/** 构造「执行一批工具」的 Cmd。 */
export function executeToolCallsCmd(toolCalls: ToolCall[]): CmdType {
  return Cmd.run(executeToolCalls, {
    args: [Cmd.dispatch, Cmd.getState, toolCalls],
    successActionCreator: (count: number): AgentAction => ({ type: 'tools/done', count }),
    failActionCreator: (error: unknown): AgentAction => ({
      type: 'llm/failed',
      error: error instanceof Error ? error.message : String(error),
    }),
  });
}

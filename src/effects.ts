/**
 * Effect 表 —— 一切皆 Action 的另一半。
 *
 * reducer 是纯表：action → (state, effect)。effect 由谁来做，是**接线**的事：
 *
 *   - CLI：effect 直接调 pi-ai（createModels/deepseekProvider + streamSimple），
 *           并由 redux-loop 执行 Cmd.run —— 环自己转。
 *   - Web：effect 是 `agent.run` → pi-agent-core 的 Agent.prompt()，
 *           Agent 自己会再发 LLM/工具回合，事件经桥回流成 action —— 环还是同一个环。
 *
 * 两张表对 reducer 是同一个形状。reducer 里没有 if (kind === 'agent')，
 * 只有「这个 action 类型的 effect 是谁」。
 */
import { Cmd, type CmdType } from 'redux-loop';
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { AgentAction } from './actions';
import type { AgentState } from './state';
import { getTool, getTools } from './tools';
import { beginRun, endRun } from './run-control';
import { resolveApiKey, type StreamFn } from './provider';

/** effect 表：每个名字返回一个 Cmd。 */
export interface EffectTable {
  /** 跑一轮对话（= 调一次 LLM）。text 只在 agent-driven 表里有用。 */
  runAgent(text?: string | undefined): CmdType;
  /** 执行一批工具调用。 */
  runTools(calls: ToolCall[]): CmdType;
}

/** 交给 LLM 的工具描述（去掉 execute，只留 schema）。 */
function toolSchemas(): Tool[] {
  return getTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * pi-ai 版 effect 表：LLM 与工具都自己跑（CLI 用）。
 */
export interface PiAiEffectsOptions {
  streamFn: StreamFn;
  model: Model<any>;
  /** node-only：浏览器里没有 process.env，交给宿主注入 key。 */
  resolveKey?: (provider: string) => string | undefined;
}

export function createPiAiEffectTable(options: PiAiEffectsOptions): EffectTable {
  const { streamFn, model } = options;
  const keyOf = options.resolveKey ?? resolveApiKey;

  async function callLlm(
    dispatch: Cmd.Dispatch,
    getState: Cmd.GetState,
  ): Promise<AssistantMessage> {
    const state = getState<AgentState>();
    const context: Context = {
      systemPrompt: state.systemPrompt,
      messages: state.messages,
      tools: toolSchemas(),
    };
    const controller = beginRun();
    try {
      const apiKey = keyOf(model.provider);
      const streamOptions: SimpleStreamOptions = { signal: controller.signal };
      if (apiKey !== undefined) streamOptions.apiKey = apiKey;
      const stream = streamFn(model, context, streamOptions);
      let final: AssistantMessage | undefined;
      for await (const event of stream) {
        if (event.type === 'text_delta' && event.delta) {
          dispatch({ type: 'llm.delta', delta: event.delta });
        } else if (event.type === 'thinking_delta' && event.delta) {
          dispatch({ type: 'llm.thinking', delta: event.delta });
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

  function toToolResult(
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

  async function runToolCall(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage> {
    const tool = getTool(call.name);
    if (!tool) {
      return toToolResult(
        call,
        [{ type: 'text', text: `未知工具：${call.name}` }],
        null,
        true,
      );
    }
    try {
      const result = await tool.execute(call.id, call.arguments ?? {}, signal);
      return toToolResult(call, result.content, result.details, false);
    } catch (error) {
      return toToolResult(
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

  async function executeToolCalls(
    dispatch: Cmd.Dispatch,
    _getState: Cmd.GetState,
    calls: ToolCall[],
  ): Promise<number> {
    const controller = beginRun();
    try {
      const results = await Promise.all(
        calls.map(async (call) => {
          dispatch({ type: 'tool/start', call });
          const message = await runToolCall(call, controller.signal);
          dispatch({ type: 'tool.result', message });
          return message;
        }),
      );
      return results.length;
    } finally {
      endRun();
    }
  }

  return {
    runAgent: () =>
      Cmd.run(callLlm, {
        args: [Cmd.dispatch, Cmd.getState],
        successActionCreator: (message: AssistantMessage): AgentAction => ({
          type: 'llm.done',
          message,
        }),
        failActionCreator: (error: unknown): AgentAction => ({
          type: 'llm.failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      }),

    runTools: (calls: ToolCall[]) =>
      Cmd.run(executeToolCalls, {
        args: [Cmd.dispatch, Cmd.getState, calls],
        successActionCreator: (count: number): AgentAction => ({
          type: 'tool.batch.done',
          count,
        }),
        failActionCreator: (error: unknown): AgentAction => ({
          type: 'llm.failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      }),
  };
}

/**
 * pi-agent-core 版 effect 表：runAgent 变成一次 `Agent.prompt()`，
 * 之后 LLM/工具回合由 Agent 自己驱动，事件经桥回流成 action（Web 用）。
 *
 * 这张表证明 reducer 不关心 agent 是什么 —— 它只是「agent.run」这一行的实现。
 */
export interface AgentDrivenEffectOptions {
  /** pi-agent-core 的 Agent（可以是桥接过的 Proxy）。 */
  agent: { prompt(input: string): Promise<void> };
}

/**
 * 成功不产出 action：`Cmd.run` 必须给一个 successActionCreator，这里用哨兵值
 * `agent.handoff` —— reducer 的 transition 表里没有这一项，所以它只是个穿过状态树的
 * 记账标记（相位由 Agent 事件经桥改）。真正的回合结果由 llm.done / llm.failed 写入。
 */
const HANDOFF = { type: 'agent.handoff' } as unknown as AgentAction;

export function createAgentDrivenEffectTable(options: AgentDrivenEffectOptions): EffectTable {
  const { agent } = options;

  return {
    runAgent: (text?: string) =>
      Cmd.run(
        async () => {
          if (text) await agent.prompt(text);
          return HANDOFF;
        },
        {
          successActionCreator: (next: AgentAction) => next,
          failActionCreator: (error: unknown): AgentAction => ({
            type: 'llm.failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ),
    runTools: () =>
      // Web 侧工具由 Agent 内部执行（pi-web-ui 需要它自己的 registry），这里不重复跑。
      Cmd.run(() => HANDOFF, { successActionCreator: (next: AgentAction) => next }),
  };
}

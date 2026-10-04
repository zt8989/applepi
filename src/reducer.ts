import { Cmd, loop, type CmdType, type LoopReducer } from 'redux-loop';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentAction, AgentActionType } from './actions';
import { createInitialState, type AgentState } from './state';

/**
 * 一张纯表：action → (下一个状态, 该发哪些 effect)。
 *
 * 没有 if (kind === 'agent')，没有 driver/mode：reducer 只做两件事，
 * 算状态、查「这个 action 类型的 effect 是谁」。`agent.run` 与 `tool.call` 在这里
 * 完全平级 —— 它们各自有一行，各自的效果来自注入的 effect 表。
 *
 * 环写出来就是这个表自己接上的：
 *   user.message    → [agent.run]
 *   agent.run       → [llm.done]（effect 回流）
 *   llm.done        → 无工具：[ ]（结束）／有工具：[tool.call]
 *   tool.call       → [tool.batch.done]（effect 回流）
 *   tool.batch.done → [agent.run]   ← 环在这里闭合
 */
export type ReducerEffects = {
  [K in AgentActionType]: (
    action: Extract<AgentAction, { type: K }>,
    state: AgentState,
  ) => CmdType[];
};

/**
 * 状态迁移表（纯函数，无副作用）。用映射类型让每个 handler 的 action
 * 自动收窄到自己那一个 variant（否则联合类型上取不到 .delta/.message 之类）。
 */
type TransitionHandlers = {
  [K in AgentActionType]: (
    state: AgentState,
    action: Extract<AgentAction, { type: K }>,
  ) => AgentState;
};

const transitions: TransitionHandlers = {
  'user.message': (state, action) => {
    if (state.phase !== 'idle') return state;
    const message: Message = { role: 'user', content: action.text, timestamp: Date.now() };
    return {
      ...state,
      phase: 'thinking',
      error: null,
      aborted: false,
      streamingText: '',
      thinkingText: '',
      pendingToolCalls: [],
      executing: [],
      messages: [...state.messages, message],
    };
  },

  // 只负责起相位：真正调模型的是 effect。
  'agent.run': (state) => {
    if (state.phase === 'thinking') return state;
    return {
      ...state,
      phase: 'thinking',
      error: null,
      aborted: false,
      streamingText: '',
      thinkingText: '',
      pendingToolCalls: [],
      executing: [],
    };
  },

  'llm.delta': (state, action) =>
    state.phase === 'thinking'
      ? { ...state, streamingText: state.streamingText + action.delta }
      : state,

  'llm.thinking': (state, action) =>
    state.phase === 'thinking'
      ? { ...state, thinkingText: state.thinkingText + action.delta }
      : state,

  'llm.done': (state, action) => {
    if (state.phase === 'idle') return state;
    const message: AssistantMessage = action.message;
    const toolCalls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
    return {
      ...state,
      messages: [...state.messages, message],
      streamingText: '',
      thinkingText: '',
      turns: state.turns + 1,
      usage: message.usage ?? state.usage,
      totalCost: state.totalCost + (message.usage?.cost?.total ?? 0),
      pendingToolCalls: toolCalls,
      error: message.errorMessage ?? state.error,
      phase: toolCalls.length > 0 ? 'calling-tools' : 'idle',
    };
  },

  'llm.failed': (state, action) => ({
    ...state,
    phase: 'idle',
    error: action.error,
    streamingText: '',
    thinkingText: '',
    executing: [],
    aborted: action.error.toLowerCase().includes('abort'),
  }),

  'tool.call': (state, action) =>
    state.phase === 'idle'
      ? { ...state, phase: 'calling-tools', pendingToolCalls: action.calls }
      : state,

  'tool/start': (state, action) => ({
    ...state,
    executing: [...state.executing, { call: action.call, startedAt: Date.now() }],
  }),

  'tool.result': (state, action) => {
    const result: ToolResultMessage = action.message;
    const exists = state.messages.some(
      (m) => m.role === 'toolResult' && m.toolCallId === result.toolCallId,
    );
    if (exists) return state;
    return {
      ...state,
      executing: state.executing.filter((t) => t.call.id !== result.toolCallId),
      pendingToolCalls: state.pendingToolCalls.filter((c) => c.id !== result.toolCallId),
      messages: [...state.messages, result],
    };
  },

  // 工具批次收尾：还能再来一轮就回 thinking（effect 会发 agent.run），
  // 撞上轮数上限就直接收工回 idle —— 相位必须在这里闭合，否则 waitForIdle 永远等不到。
  'tool.batch.done': (state) => {
    if (state.phase !== 'calling-tools') return state;
    if (state.turns >= state.maxTurns) {
      return {
        ...state,
        phase: 'idle',
        error: `已达单回合工具调用上限（${state.maxTurns} 轮），停止。`,
      };
    }
    return { ...state, phase: 'thinking', streamingText: '', thinkingText: '' };
  },

  'model.changed': (state, action) => ({
    ...state,
    providerName: action.provider,
    modelId: action.modelId,
  }),

  'conversation.reset': (state) =>
    createInitialState({
      systemPrompt: state.systemPrompt,
      providerName: state.providerName,
      modelId: state.modelId,
      toolNames: state.toolNames,
      maxTurns: state.maxTurns,
    }),
};

/** 没有登记的 action 就是「纯状态变更」，不产生 Cmd。 */
const NO_EFFECT = (): CmdType[] => [];

/**
 * 接线表在运行时只是一张 `Record<string, fn>`，但 TS 看到的类型是所有 key 的交叉，
 * 取值时必须按具体 key 收窄。所以内部用「已收窄」的一侧，构造时再 cast 回去。
 */
type EffectFor<K extends AgentActionType> = ReducerEffects[K];
type AnyEffect = EffectFor<AgentActionType>;

export function createAgentReducer(
  effects: Partial<ReducerEffects>,
): LoopReducer<AgentState, AgentAction> {
  const table = { ...(effects as Record<string, AnyEffect | undefined>) } as Record<
    string,
    AnyEffect
  >;
  const transitionsByType = transitions as unknown as Record<
    string,
    (s: AgentState, a: AgentAction) => AgentState
  >;

  return (state, action) => {
    if (state === undefined) {
      throw new Error('agentReducer 需要一个确定的初始状态');
    }
    // redux-loop 会塞一个 @@REDUX_LOOP/* 的哨兵 action 进来（默认处理检查），
    // 状态照原样返回即可，别去查表。
    const typed = action as AgentAction;
    const transition = transitionsByType[typed.type];
    if (!transition) return state;

    const nextState = transition(state, typed);
    // table 的值类型是所有 handler 的交叉，调用点必须按「接受任意 action」的一侧来 cast。
    const emit = (table[typed.type] ?? NO_EFFECT) as (a: AgentAction, s: AgentState) => CmdType[];
    const cmds = emit(typed, state) ?? [];
    if (cmds.length === 0) return nextState;
    // redux-loop 的 loop(state, cmd) 只收一个命令；多个命令用 Cmd.list 打包。
    const [first, ...rest] = cmds;
    return rest.length === 0
      ? loop(nextState, first as CmdType)
      : loop(nextState, Cmd.list(cmds));
  };
}

/** pi-ai / agent-driven 两种表共用的接线：LLM 有工具调用就转 tool.call，工具跑完就再转 agent.run。 */
export function loopWiring(table: {
  runAgent(text?: string): CmdType;
  runTools(calls: ToolCall[]): CmdType;
}): Pick<ReducerEffects, 'user.message' | 'agent.run' | 'llm.done' | 'tool.batch.done'> {
  return {
    'user.message': (action) => [table.runAgent((action as { text: string }).text)],
    'agent.run': (action) => [table.runAgent((action as { text?: string }).text)],
    'llm.done': (action, state) => {
      if (state.phase !== 'thinking') return [];
      const message = (action as { message: AssistantMessage }).message;
      const toolCalls = message.content.filter((c): c is ToolCall => c.type === 'toolCall');
      return toolCalls.length > 0 ? [table.runTools(toolCalls)] : [];
    },
    'tool.batch.done': (_action, state) =>
      state.turns >= state.maxTurns ? [] : [table.runAgent()],
  };
}

export { transitions as _transitions };

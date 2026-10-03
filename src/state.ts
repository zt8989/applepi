import type { Message, ToolCall, Usage } from '@earendil-works/pi-ai';

/** Agent 生命周期阶段。 */
export type Phase = 'idle' | 'thinking' | 'calling-tools';

/** 正在执行的工具调用（UI 展示用）。 */
export interface ExecutingTool {
  call: ToolCall;
  startedAt: number;
}

/**
 * Agent 全量状态 —— Redux 单一状态树。
 * messages 直接持有 pi-ai 的 Message[]（user / assistant / toolResult），
 * 它们是纯数据，可以直接作为 LLM 的下一轮输入。
 */
export interface AgentState {
  phase: Phase;
  systemPrompt: string;
  providerName: string;
  modelId: string;
  messages: Message[];
  /** 已注册工具名（展示用；定义在 deps 里，不进状态树）。 */
  toolNames: readonly string[];
  /** 当前流式回合已累积的助手文本。 */
  streamingText: string;
  /** 当前回合已累积的 thinking 文本。 */
  thinkingText: string;
  /** 最新一条 assistant 消息要求执行、尚未执行完的工具调用。 */
  pendingToolCalls: ToolCall[];
  executing: readonly ExecutingTool[];
  /** 已完成的 LLM 轮数。 */
  turns: number;
  maxTurns: number;
  /** 最近一次 LLM 用量。 */
  usage: Usage | null;
  /** 累计花费（美元）。 */
  totalCost: number;
  error: string | null;
  aborted: boolean;
}

export interface InitialStateOptions {
  systemPrompt: string;
  providerName: string;
  modelId: string;
  toolNames: readonly string[];
  maxTurns?: number;
}

export function createInitialState(options: InitialStateOptions): AgentState {
  return {
    phase: 'idle',
    systemPrompt: options.systemPrompt,
    providerName: options.providerName,
    modelId: options.modelId,
    messages: [],
    toolNames: options.toolNames,
    streamingText: '',
    thinkingText: '',
    pendingToolCalls: [],
    executing: [],
    turns: 0,
    maxTurns: options.maxTurns ?? 25,
    usage: null,
    totalCost: 0,
    error: null,
    aborted: false,
  };
}

import type { Message, ToolCall, Usage } from '@earendil-works/pi-ai';

/** 相位：只描述「现在在等谁」，不含任何驱动方式的信息。 */
export type Phase = 'idle' | 'thinking' | 'calling-tools';

export interface ExecutingTool {
  call: ToolCall;
  startedAt: number;
}

/**
 * 状态树。纯数据。
 *
 * 这里刻意**没有** driver / mode 之类的字段：CLI 和 Web 共用同一棵树、
 * 同一个 reducer，差别只在注入的 effect 表。
 */
export interface AgentState {
  phase: Phase;
  systemPrompt: string;
  providerName: string;
  modelId: string;
  /** 对话消息（user / assistant / toolResult），LLM 的下一轮输入。 */
  messages: Message[];
  /** 已注册工具名（展示用）。 */
  toolNames: readonly string[];
  /** 本轮流式累积的助手文本。 */
  streamingText: string;
  /** 本轮流式累积的思考文本。 */
  thinkingText: string;
  /** 最近一批待执行的工具调用。 */
  pendingToolCalls: ToolCall[];
  executing: readonly ExecutingTool[];
  /** 已完成的 LLM 轮数。 */
  turns: number;
  maxTurns: number;
  usage: Usage | null;
  totalCost: number;
  error: string | null;
  aborted: boolean;
}

export interface InitialStateOptions {
  systemPrompt: string;
  providerName: string;
  modelId: string;
  toolNames: readonly string[];
  maxTurns?: number | undefined;
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

import type { Message, ModelThinkingLevel, ToolCall, Usage } from '@earendil-works/pi-ai';
import { createTraceTree, newSessionId, type TraceTree } from './trace';

/** 相位：只描述「现在在等谁」，不含任何驱动方式的信息。 */
export type Phase = 'idle' | 'thinking' | 'calling-tools';

export interface ExecutingTool {
  call: ToolCall;
  startedAt: number;
}

/** LLM 失败的类别 —— 决定它是不是「可重试」的（超时/网络可重试，鉴权/参数不行）。 */
export type LlmErrorKind = 'timeout' | 'network' | 'auth' | 'model' | 'aborted' | 'unknown';

export interface AgentState {
  phase: Phase;
  systemPrompt: string;
  providerName: string;
  modelId: string;
  /** 思考级别（pi-ai 的 ModelThinkingLevel）；'off' 表示不带 reasoning。 */
  thinkingLevel: ModelThinkingLevel;
  /** 对话消息（user / assistant / toolResult），LLM 的下一轮输入。 */
  messages: Message[];
  /** 已注册工具名（展示用）。 */
  toolNames: readonly string[];
  /** 本轮流式累积的助手文本。 */
  streamingText: string;
  /** 本轮流式累积的思考文本。 */
  thinkingText: string;
  /**
   * 每开始一次 LLM 尝试就 +1。UI 靠它识别「又发起了一次调用」——
   * 这正是重试发生的那一刻，也是树上要开新 attempt 分支的那一刻。
   */
  streamSeq: number;
  /** 最近一批待执行的工具调用。 */
  pendingToolCalls: ToolCall[];
  executing: readonly ExecutingTool[];
  /** 已完成的 LLM 轮数。 */
  turns: number;
  maxTurns: number;
  usage: Usage | null;
  totalCost: number;
  error: string | null;
  /**
   * 最近一次错误对应的轨迹节点 id。界面靠它把「这次失败」和树上的节点对上，
   * 于是错误不只是状态里的一句字符串，而是树上看得见、能展开的一节点。
   */
  errorNodeId: string | null;
  /** 最近一次错误的类别。 */
  errorKind: LlmErrorKind | null;
  /** 这次失败正在自动重试（UI 显示「重试中…」）。 */
  retrying: boolean;
  aborted: boolean;

  // ─── 轨迹树（trace tree） ───
  /** 像 git log 一样的一次尝试一节点的执行历史。 */
  trace: TraceTree;
  /** 当前在跑的 LLM 尝试节点 id；没有则 null。 */
  openLlmNodeId: string | null;
  /** 正在执行的工具 → 它的 attempt 节点 id。 */
  openToolNodeIds: Readonly<Record<string, string>>;
  /** 本轮（从 user.message 起）已发起的 LLM 尝试次数；用来判「还有没有重试机会」。 */
  llmAttempts: number;
  /** 允许的最大 LLM 尝试次数（含首次），2 = 失败后重试一次。 */
  maxLlmAttempts: number;
  /** 一次 LLM 调用的超时（毫秒）。effect 读它给流上闸。 */
  llmTimeoutMs: number;
  /** 已经落盘到 seq 游标的节点数；持久化失败时不动，好让下一轮重试。 */
  persistedSeq: number;
}

export interface InitialStateOptions {
  systemPrompt: string;
  providerName: string;
  modelId: string;
  toolNames: readonly string[];
  thinkingLevel?: ModelThinkingLevel | undefined;
  maxTurns?: number | undefined;
  /** 一次 LLM 调用的超时（毫秒）；超时按可重试错误处理。 */
  llmTimeoutMs?: number | undefined;
  /** 单轮内最多几次 LLM 尝试（含首次），2 = 失败后重试一次。 */
  maxLlmAttempts?: number | undefined;
  /** 注入会话 id（测试用；默认按时间生成）。 */
  sessionId?: string | undefined;
  /** 注入已存在的轨迹（从 JSONL 回放时用）。 */
  trace?: TraceTree | undefined;
}

export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export function createInitialState(options: InitialStateOptions): AgentState {
  return {
    phase: 'idle',
    systemPrompt: options.systemPrompt,
    providerName: options.providerName,
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel ?? 'off',
    messages: [],
    toolNames: options.toolNames,
    streamingText: '',
    thinkingText: '',
    streamSeq: 0,
    pendingToolCalls: [],
    executing: [],
    turns: 0,
    maxTurns: options.maxTurns ?? 25,
    usage: null,
    totalCost: 0,
    error: null,
    errorNodeId: null,
    errorKind: null,
    retrying: false,
    aborted: false,
    trace: options.trace ?? createTraceTree(options.sessionId ?? newSessionId()),
    openLlmNodeId: null,
    openToolNodeIds: {},
    llmAttempts: 0,
    maxLlmAttempts: options.maxLlmAttempts ?? 2,
    llmTimeoutMs: options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    persistedSeq: 0,
  };
}

/** 这些错误重试有意义：网络抖动、超时。鉴权/参数错重试多少次都一样。 */
export function isRetryable(kind: LlmErrorKind): boolean {
  return kind === 'timeout' || kind === 'network';
}

/** 从错误信息猜类别（effect 只拿到一个 Error，分类放在这里统一做）。 */
export function classifyLlmError(error: string): LlmErrorKind {
  const text = error.toLowerCase();
  if (text.includes('abort')) return 'aborted';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('超时')) {
    return 'timeout';
  }
  if (
    text.includes('network') ||
    text.includes('fetch failed') ||
    text.includes('econnreset') ||
    text.includes('socket hang up') ||
    text.includes('enotfound') ||
    text.includes('网络')
  ) {
    return 'network';
  }
  if (
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('api key') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('鉴权')
  ) {
    return 'auth';
  }
  if (text.includes('model') || text.includes('模型')) return 'model';
  return 'unknown';
}

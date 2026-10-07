import type { Message, ModelThinkingLevel, ToolCall, Usage } from '@earendil-works/pi-ai';
import type { ModelCapabilities, PromptToolDefinition } from './actions';
import type { SkillInfo } from './skills';
import { createTraceTree, newSessionId, type TraceTree } from './trace';

/** 相位：只描述「现在在等谁」，不含任何驱动方式的信息。 */
export type Phase = 'idle' | 'thinking' | 'calling-tools';

export interface ExecutingTool {
  call: ToolCall;
  startedAt: number;
}

/** LLM 失败的类别 —— 决定它是不是「可重试」的（超时/网络可重试，鉴权/参数不行）。 */
export type LlmErrorKind = 'timeout' | 'network' | 'auth' | 'model' | 'aborted' | 'unknown';

/**
 * 回合为什么停了 —— 界面据此区分「正常收工」和「被砍」。
 *
 * ## 为什么不能靠 errorKind 猜
 *
 * `errorKind` 说的是「LLM 调用失败的原因」，它对「撞轮数上限」这种**根本没失败**的情况没有定义
 * （一直是 null）。而 `error` 又只是一句给人看的字符串，界面没法拿它做判断。
 * 结果就是：撞上限、LLM 报错、手动中断在界面上长得一模一样，只能靠猜。
 *
 * - `completed`：模型自己说完了，正常的。
 * - `maxTurns`：撞了单回合轮数上限，被砍。
 * - `error`：LLM 调用失败（配 `errorKind` 看是哪一类）。
 * - `aborted`：用户手动中断。
 */
export type StopReason = 'completed' | 'maxTurns' | 'error' | 'aborted';
/**
 * ═══ 停止的**具体原因** ═══
 *
 * `StopReason` 只说「这一轮是哪种结局」，它把好几件事压成了一个 `error`：模型超时、网络抖动、
 * 鉴权失败、工具批次整体挂掉、用户自己按了中断 —— 界面上全都长得一样（一条红字）。
 *
 * 这一层把「为什么停」拆细，界面与日志直接念它，不必去猜 `error` 的文案：
 *
 *   - `user`：用户手动中断（Ctrl-C / Web 的停止按钮）。**不是故障**，不该弹红框。
 *   - `timeout` / `network` / `auth` / `model` / `llm-error`：LLM 调用失败，细分到能对上处置办法。
 *   - `tool-error`：工具批次整体挂掉（LLM 根本没在跑）。
 *   - `maxTurns`：撞单回合轮数上限。
 *   - `completed`：模型自己说完了。
 *   - `shutdown`：进程/内核被关停（主动 abort 的非用户来源）。
 *
 * 它由 `llm.failed` / `llm.giveup` 这两条 action 带进来 —— 见 actions.ts 的 `cause` 字段。
 */
export type StopCause =
  | 'completed'
  | 'maxTurns'
  | 'user'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'model'
  | 'llm-error'
  | 'tool-error'
  | 'shutdown';

/** 停止原因 → 一句人话（界面与日志直接用，不必各写一份文案）。 */
export function stopCauseText(cause: StopCause): string {
  switch (cause) {
    case 'user':
      return '用户手动中断';
    case 'timeout':
      return '大模型调用超时';
    case 'network':
      return '网络错误';
    case 'auth':
      return '鉴权失败（API key 无效或无权限）';
    case 'model':
      return '模型侧报错';
    case 'llm-error':
      return '大模型调用失败';
    case 'tool-error':
      return '工具批次整体失败';
    case 'maxTurns':
      return '已达单回合轮数上限';
    case 'shutdown':
      return '被内核关闭';
    case 'completed':
      return '模型自己说完了';
  }
}


/**
 * prompt 侧状态 —— 与 model 分开装载：prompt 是「跟模型说什么」，model 是「用哪个模型说」。
 * 整块由 `prompt.init` 装载，之后只被 `prompt.segment.added` 追加。
 *
 * 有了它，回放时不必重跑就知道当时发给模型的是什么。
 *
 * 扩展（洋葱式 middleware）不写在这里 —— 它横切所有 action，见 src/middleware.ts。
 */
export interface PromptState {
  /** 基础 system prompt。 */
  systemPrompt: string;
  /** 工具的完整定义（原样进 LLM 请求的那三样）。 */
  tools: PromptToolDefinition[];
  /**
   * 装进来的 skill 清单（`skills.ts` + 官方 `loadSkills()`）。
   *
   * **可选**而不是必填：旧轨迹回放与测试的 init 段里没有这个字段，所以判据要用
   * `undefined`（没装）而不是空数组（装了但一个都没有）。
   */
  skills?: SkillInfo[];
  /**
   * skill 加载的诊断（重名、frontmatter 不合法…）。
   *
   * 为什么要留在状态里而不只是打到 stderr：TUI 模式下 stderr 用户看不见，而「某个
   * skill 没加载上」正是**静默退化** —— 模型少了能力，用户与界面都不知道原因。
   * pi 把这类信息印在开场（`[Skill conflicts]`），我们也照做。
   */
  skillDiagnostics?: string[];
  /** 是否已经装载过。回放时据此判断「init 段读到了没有」。 */
  seeded: boolean;
}

/** 模型侧状态 —— 由 `model.init` 装载。 */
export interface ModelState {
  provider: string;
  modelId: string;
  /** 当前思考级别；`off` 表示不带 reasoning。 */
  thinkingLevel: ModelThinkingLevel;
  /** 这个模型支持什么（中途插 system / developer role / 中途加工具）。 */
  capabilities: ModelCapabilities;
  /**
   * 上下文窗口（token）。底箱用它算「已用 / 窗口」。
   *
   * 不知道就是 0（而不是猜一个值）：底箱会据此决定画不画那个百分比。
   */
  contextWindow: number;
  seeded: boolean;
}

export interface AgentState {
  phase: Phase;

  // ── prompt 侧（与 model 分开，因为 system prompt 后面要挂 Hooks） ──
  prompt: PromptState;
  // ── model 侧 ──
  model: ModelState;

  /**
   * 下面四个是 prompt / model 里常用字段的**扁平别名**，为了不让既有代码（UI、adapter、
   * 轨迹渲染）到处写 `state.prompt.systemPrompt`。真相在两块里，别处只读不算独立来源。
   */
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
  /** 最近一次错误的类别。 */
  errorKind: LlmErrorKind | null;
  /**
   * 回合为什么停了。`null` = 还在跑（idle 但没有收工理由 = 空闲，等下一句话）。
   *
   * 界面靠它决定怎么显示：`completed` 不该弹红框，`maxTurns` / `error` / `aborted` 要弹。
   */
  stopReason: StopReason | null;
  /**
   * 停止的**具体原因**（`StopCause`）。`null` = 这一轮还没停。
   *
   * 与 `stopReason` 的分工：`stopReason` 给「粗粒度的结局」（要不要弹红框），
   * 这个给「到底为什么」—— 用户手动中断、超时、鉴权失败在 `stopReason` 里都是 `error`/`aborted`，
   * 只有这里能分开。界面照它分色（用户中断是灰的、超时是黄的），日志照它写。
   */
  stopCause: StopCause | null;
  /**
   * 停止原因的一句人话，界面直接显示（免得每个界面各写一份 switch）。
   *
   * 为什么存在：`error` 是技术文案（`401 Unauthorized`），用户看不懂也不想看；
   * 这一句是给他看的（「鉴权失败，API key 无效或无权限」）。
   */
  stopCauseDetail: string | null;
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
  /**
   * 已完成工具的**耗时**（毫秒），key 是 toolCallId。
   *
   * ## 为什么单独存一份，而不是去轨迹树上刨
   *
   * 界面要显示 `Took 0.5s`（pi 的 bash 块底部那行）。轨迹树上其实也有时间戳
   * （`tool.attempt.createdAt` / `endedAt`），但那条路要「按 toolName 猜是哪个节点」——
   * 同名工具连着调两次就猜错了，而猜错的表现是**显示一个错的数字**，不报错，最难发现。
   *
   * reducer 的 `tool.result` 拿得到这次调用的 id 与时刻，直接记一份即可：
   * **唯一真相、零猜测**。它只进界面，不进 prompt（`details` 那条路才进 prompt），
   * 所以不会污染发给模型的上下文，也不会被写进会话文件。
   *
   * 会话文件里不带它：恢复历史时 `state` 是从消息重建的，这些耗时显示不出来就显示不出来
   * （显示 `Took` 一个假数字比不显示更糟）。
   */
  toolTimings: Readonly<Record<string, number>>;
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
  // 初始值就是「空的 prompt / model 块」—— 内核随后会 dispatch prompt.init 与 model.init
  // 把真值装进去。构造函数只负责给形状，不负责装载。
  const emptyPrompt: PromptState = {
    systemPrompt: options.systemPrompt,
    tools: [],
    seeded: false,
  };
  const emptyModel: ModelState = {
    provider: options.providerName,
    modelId: options.modelId,
    thinkingLevel: options.thinkingLevel ?? 'off',
    capabilities: {
      midConvoSystemMessages: false,
      midConvoToolAdditions: false,
      developerRole: false,
    },
    // 不知道就是 0：底箱会不画那个百分比，而不是画一个猜的值。
    contextWindow: 0,
    seeded: false,
  };
  return {
    phase: 'idle',
    prompt: emptyPrompt,
    model: emptyModel,
    systemPrompt: options.systemPrompt,
    providerName: options.providerName,
    modelId: options.modelId,
    thinkingLevel: emptyModel.thinkingLevel,
    messages: [],
    toolNames: options.toolNames,
    streamingText: '',
    thinkingText: '',
    streamSeq: 0,
    pendingToolCalls: [],
    executing: [],
    turns: 0,
    // 默认**不设上限**：一次提问就是一条 ReAct 循环，模型要查多少轮由它自己说了算。
    // 曾经默认 25，表现为「模型正干着活突然停了」—— 但用户只发了一条消息，
    // 是 25 次 LLM 调用把这个大需求砍断了。命令行的 --max-turns 仍可显式设一个兜底值。
    maxTurns: options.maxTurns ?? Number.POSITIVE_INFINITY,
    usage: null,
    totalCost: 0,
    error: null,
    errorNodeId: null,
    errorKind: null,
    stopReason: null,
    stopCause: null,
    stopCauseDetail: null,
    retrying: false,
    aborted: false,
    trace: options.trace ?? createTraceTree(options.sessionId ?? newSessionId()),
    openLlmNodeId: null,
    openToolNodeIds: {},
    toolTimings: {},
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

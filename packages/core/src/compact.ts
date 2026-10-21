/**
 * 上下文压缩（compact）—— 长会话撑爆窗口时，把老对话换成一段结构化摘要。
 *
 * 本文件只做两件事：**决定要不要压**、**把结果落到我们的状态里**。中间最要紧的几步直接调
 * pi-coding-agent 的 `core/compaction/`：判定 (`shouldCompact`)、token 估算
 * (`estimateTokens`)、找切点 (`findCutPoint`)、生成摘要 (`generateSummaryWithUsage`)、
 * 摘要标记 (`COMPACTION_SUMMARY_PREFIX/SUFFIX`)、溢出识别 (pi-ai 的 `isContextOverflow`)、
 * 默认参数 (`DEFAULT_COMPACTION_SETTINGS`)。
 *
 * 必须复用：摘要的**格式**是模型续接时的契约（下游靠 `## Next Steps` 决定接着做什么），
 * 切点的**安全规则**（不能切在 toolResult 中间，否则消息序列变成「有 call 没 result」，
 * provider 直接报错）都是踩过坑定下来的。抄一遍迟早漂移，而漂移的症状是「压缩之后模型
 * 突然不知道自己在干嘛」。
 *
 * 与 pi 的差别只有会话模型：pi 的切点算法吃 `SessionEntry[]`，我们的 `state.messages` 是扁平
 * 的 `Message[]`，所以 `toCuttableEntries()` 包一层，算法退化成「在消息序列里找切点」。
 */
import {
  calculateContextTokens,
  estimateTokens,
  findCutPoint,
  generateSummaryWithUsage,
  shouldCompact,
  DEFAULT_COMPACTION_SETTINGS,
  type CompactionSettings,
} from '@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js';
import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from '@earendil-works/pi-coding-agent/dist/core/messages.js';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import type {
  AssistantMessage,
  Message,
  Model,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import type { StreamFn } from './provider';
import type { AgentState } from './state';
import { piAgentDir } from './pi-config';

export { DEFAULT_COMPACTION_SETTINGS, shouldCompact, isContextOverflow };
export type { CompactionSettings };

/**
 * 一条压缩摘要消息 —— 进 `state.messages`，发给模型时就是一条普通的 user 消息。
 *
 * 做成消息而不是 `state.summary` 之类的字段：对话历史只有一条真相，另开字段就得同时改
 * `effects.ts`（拼进 context）、落盘器、回放三处，各留一条「别忘了带上摘要」的隐式约定。
 *
 * 用 intersection 而不是 extends：`Message` 是判别联合，TS 不许 interface 继承联合类型。
 */
export type CompactionSummaryMessage = UserMessage & {
  /** 压缩前的上下文 token 数（界面显示「压掉了多少」用）。 */
  tokensBefore: number;
  /** 这条是压缩摘要（回放时据此识别）。 */
  compactionSummary: true;
};

/**
 * 压缩理由 → 一个短词（节点 label、界面提示、日志共用，避免两处各写一份文案）。
 *
 * 放在 `compact.ts` 而不是 reducer 里：它是对 `CompactReason` 这个**类型**的解释，
 * 界面也要用（显示「为什么压了」），而界面不该为了显示一句话去 import reducer。
 */
export function compactReasonText(reason: CompactReason): string {
  switch (reason) {
    case 'manual':
      return '手动';
    case 'threshold':
      return '超阈值';
    case 'overflow':
      return 'provider 报溢出';
  }
}

/**
 * 一条消息是不是压缩摘要。
 *
 * 用结构上的 `compactionSummary` 标记，不靠「内容长得像 `<summary>` 包裹」去猜 ——
 * 用户完全可能手打一段一模一样的文本，而把那句当成压缩点会让回放丢掉真历史。
 */
export function isCompactionSummary(message: Message): message is CompactionSummaryMessage {
  return (message as { compactionSummary?: unknown }).compactionSummary === true;
}

// ─── 判定：要不要压 ───

/** 压缩参数：默认沿用 pi 的，取消窗口与「保留多少」都能改。 */
export function compactionSettings(overrides?: Partial<CompactionSettings>): CompactionSettings {
  return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
}

/**
 * 按**当前模型的窗口**把压缩参数调合理（pi 的 `getCompactionSettings(model)` 不夹紧，
 * 因为它面向的模型窗口都在 64k 以上）。
 *
 * 必须夹：`shouldCompact` 的判据是 `tokens > window - reserveTokens`，窗口小的时候
 * `reserve` 会吃光整个窗口（`window=1000`、`reserve=16384` ⇒ 阈值 `-15384`），于是**任何
 * 一次调用都判定该压**，而压完只会更小 —— 每轮压一次，白花钱还把对话越压越碎。
 *
 * - `reserve` 不超过窗口的 20%（小窗口的摘要与后续输出只需一点余量）；
 * - `keepRecent` 不超过窗口的 50%（保留的部分必须装得下，否则「压了还是超」死循环）。
 *
 * 窗口为 0（不知道）时不夹紧，沿用配置原值。
 */
export function effectiveCompactionSettings(
  settings: CompactionSettings,
  contextWindow: number,
): CompactionSettings {
  if (contextWindow <= 0) return settings;
  return {
    ...settings,
    reserveTokens: Math.min(settings.reserveTokens, Math.floor(contextWindow * 0.2)),
    keepRecentTokens: Math.min(settings.keepRecentTokens, Math.floor(contextWindow * 0.5)),
  };
}

/**
 * 最后一次**有效**调用占掉的上下文 token 数；没有就 null。
 *
 * 三个过滤条件照抄 pi 的 `getAssistantUsage`：token>0、非 aborted、非 error
 * （被中断/失败那轮的 usage 描述的不是最终请求，用它算占用会得到错的数）。
 */
export function lastContextTokens(messages: readonly Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !message.usage) continue;
    if (message.stopReason === 'aborted' || message.stopReason === 'error') continue;
    const total = calculateContextTokens(message.usage);
    if (total > 0) return total;
  }
  return null;
}

/** 为什么这次要压（界面与日志直接念它，不必各写一份文案）。 */
export type CompactReason = 'manual' | 'threshold' | 'overflow';

export interface CompactDecision {
  should: boolean;
  reason: CompactReason | null;
  /** 触发判定时的上下文 token 数（reason 非 null 时有意义）。 */
  contextTokens: number | null;
}

/**
 * 要不要压，以及为什么。三条路径（与 pi 的 `_checkCompaction` 同一套语义）：
 * - `manual`：用户按了 `/compact`，不看阈值；
 * - `overflow`：provider 报了上下文溢出（含「静默溢出」——某些网关收下超长请求并正常返回，
 *   只在 `usage.input > window` 里露馅）。这是**必须**压的；
 * - `threshold`：占用超过 `window - reserveTokens`。
 *
 * overflow 需要一条 `AssistantMessage`（`isContextOverflow` 的输入），所以它只在「刚跑完
 * 一轮」那条路上有意义（见 `decideAfterTurn`）。
 */
export function decideCompaction(options: {
  state: AgentState;
  settings: CompactionSettings;
  manual?: boolean;
  lastMessage?: AssistantMessage | undefined;
}): CompactDecision {
  const { state, settings: raw, manual, lastMessage } = options;
  const contextTokens = lastContextTokens(state.messages);
  const window = state.model.contextWindow;
  // 窗口小的模型必须夹紧 reserve / keepRecent（理由见 effectiveCompactionSettings）。
  const settings = effectiveCompactionSettings(raw, window);

  if (manual) return { should: true, reason: 'manual', contextTokens };
  if (!settings.enabled) return { should: false, reason: null, contextTokens };

  // 溢出：provider 明确报了，或者「静默溢出」（收下了但 usage 显示装不下）。
  if (lastMessage !== undefined && isContextOverflow(lastMessage, window || undefined)) {
    return { should: true, reason: 'overflow', contextTokens };
  }

  if (window > 0 && contextTokens !== null && shouldCompact(contextTokens, window, settings)) {
    return { should: true, reason: 'threshold', contextTokens };
  }
  return { should: false, reason: null, contextTokens };
}

// ─── 切点：把 messages 包成 pi 那种 entry ───

/**
 * 每条消息包成一条「只含这一条消息」的 entry。
 *
 * pi 的 `findCutPoint` 要 `SessionEntry[]`；包一层就是退化成「按消息找切点」—— 语义正好，
 * pi 那套安全规则全部保留。`id` 用下标的字符串：pi 只把它当身份标识，不解析内容。
 */
function toCuttableEntries(messages: readonly Message[]): unknown[] {
  return messages.map((message, i) => ({
    type: 'message',
    id: `m${i}`,
    parentId: i === 0 ? null : `m${i - 1}`,
    timestamp: new Date(
      typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
    ).toISOString(),
    message,
  }));
}

/** 切点算完了：这次压缩要摘掉前面哪些、留哪些。 */
export interface CutPlan {
  /** 摘要覆盖的消息（会被摘掉，换成一条摘要）。 */
  summarized: Message[];
  /** 「被切开的那一轮」开头那几条（另做一段 turn-prefix 摘要，避免丢掉半轮上下文）。 */
  turnPrefix: Message[];
  /** 保留的尾巴（第一条开始）。 */
  kept: Message[];
  /** 切点落在轮次中间（于是有 turnPrefix）。 */
  isSplitTurn: boolean;
  /** 压缩前的估算 token 数。 */
  tokensBefore: number;
}

/**
 * 算切点：保留最近约 `keepRecentTokens`，前面交给摘要。
 *
 * 下面这些规则来自 pi 的 `findCutPoint`，不是我们定的：**绝不切在 toolResult 上**（它必须
 * 跟在它的 toolCall 后面，所以切点只落在 user / assistant 消息上）；切在一轮中间时另外返回
 * `turnStartIndex`，那半轮的 user 消息单独做「turn prefix」摘要（否则模型丢掉「这一轮是谁问的」）。
 *
 * @returns null = 没有值得压的东西（消息太少 / 切点找不到）。
 */
export function planCut(
  messages: readonly Message[],
  keepRecentTokens: number,
): CutPlan | null {
  const entries = toCuttableEntries(messages);
  const end = entries.length;
  const cut = findCutPoint(entries as never, 0, end, keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  // 没有历史可摘（整个会话就等于要保留的那点尾巴）：压了等于没压，还白花一次 token。
  if (historyEnd <= 0) return null;

  const summarized = messages.slice(0, historyEnd);
  const turnPrefix = cut.isSplitTurn
    ? messages.slice(cut.turnStartIndex, cut.firstKeptEntryIndex)
    : [];
  const kept = messages.slice(cut.firstKeptEntryIndex);
  // 摘要之后不能留一个孤儿 toolResult：它的 toolCall 已经被摘进摘要里了。
  if (kept.length > 0 && kept[0]?.role === 'toolResult') return null;

  const tokensBefore = messages.reduce((sum, m) => sum + estimateTokens(m), 0);
  return { summarized, turnPrefix, kept, isSplitTurn: cut.isSplitTurn, tokensBefore };
}


export interface CompactOutcome {
  /** 新的 `state.messages`：摘要消息 + 保留的尾巴。 */
  messages: Message[];
  summary: string;
  tokensBefore: number;
  /** 摘要这一次花掉的 token（记进 usage，用户能在底栏看到成本）。 */
  usage: Usage | null;
  /** 摘掉了多少条、留下了多少条（界面提示用）。 */
  summarizedCount: number;
  keptCount: number;
}

/** 拼出那条摘要消息（内容与 pi 折给模型的形状逐字一致）。 */
export function buildSummaryMessage(summary: string, tokensBefore: number): CompactionSummaryMessage {
  return {
    role: 'user',
    content: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX,
    timestamp: Date.now(),
    tokensBefore,
    compactionSummary: true,
  };
}

/**
 * 真的压一次：找切点 → 调 pi 生成摘要 → 拼出新的 messages。
 *
 * 除 `streamFn`（真的打网络）之外不碰任何外部状态、不碰 store：调用方（effect）拿结果去
 * dispatch，所以这一步可以单测。
 *
 * 摘要走**同一个模型**：另配一个「便宜的摘要模型」是另一个配置面（还要配 key），而摘要质量
 * 直接决定压缩之后模型能不能接着干。
 *
 * @param reserveTokens 摘要输出预算（pi 按它的 0.8 倍算 maxTokens）。
 * @returns null = 没有可压的内容（调用方不该改状态）。
 */
export async function runCompaction(options: {
  messages: readonly Message[];
  model: Model<any>;
  streamFn: StreamFn;
  apiKey?: string | undefined;
  thinkingLevel?: string | undefined;
  settings: CompactionSettings;
  /** 当前模型的上下文窗口（小窗口时要夹紧参数，见 effectiveCompactionSettings）。 */
  contextWindow?: number | undefined;
  signal?: AbortSignal | undefined;
  customInstructions?: string | undefined;
}): Promise<CompactOutcome | null> {
  const { messages, model, streamFn, settings: raw, signal } = options;
  // 小窗口模型要夹紧 keepRecent：否则切点会把「保留的尾巴」算得比整个窗口还大，
  // 结果一条都留不下（planCut 返回 null，用户看到「压了但没变」）。
  const settings = effectiveCompactionSettings(raw, options.contextWindow ?? 0);
  const plan = planCut(messages, settings.keepRecentTokens);
  if (plan === null) return null;

  const previousSummary = lastSummaryOf(plan.summarized);

  let summary: string;
  let usage: Usage | null = null;
  try {
    const result = await generateSummaryWithUsage(
      plan.summarized,
      model,
      settings.reserveTokens,
      options.apiKey,
      undefined, // headers
      signal,
      options.customInstructions,
      previousSummary,
      options.thinkingLevel as never,
      streamFn,
    );
    summary = result.text;
    usage = result.usage;
  } catch (error) {
    // 摘要失败**绝不能**改状态：压缩是优化，不是正确性要求。
    // 半路丢掉历史而没换上一份摘要，等于把上下文毁掉 —— 比不压糟糕得多。
    throw new Error(
      `上下文压缩失败（对话原样保留）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 半轮切开时，前缀那半轮另做一段摘要并拼在后面（pi 的合并形状：
  // `history\n\n---\n\n**Turn Context (split turn):**\n\n…`）。
  if (plan.isSplitTurn && plan.turnPrefix.length > 0) {
    const prefix = await generateSummaryWithUsage(
      plan.turnPrefix,
      model,
      settings.reserveTokens,
      options.apiKey,
      undefined,
      signal,
      undefined,
      undefined,
      options.thinkingLevel as never,
      streamFn,
    );
    summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix.text}`;
    usage = usage ?? prefix.usage;
  }

  const tokensBefore = plan.tokensBefore;
  return {
    messages: [buildSummaryMessage(summary, tokensBefore), ...plan.kept],
    summary,
    tokensBefore,
    usage,
    summarizedCount: plan.summarized.length,
    keptCount: plan.kept.length,
  };
}

/** 尾巴里已经有过摘要就把它当 previousSummary（迭代压缩，不从零开始）。 */
function lastSummaryOf(messages: readonly Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || !isCompactionSummary(message)) continue;
    // `UserMessage.content` 允许是 content 块数组，但我们自己只写字符串；
    // 落到数组分支就说明这条不是我们拼的，直接原样当摘要用（宁可多给一点上下文）。
    const text = message.content;
    if (typeof text !== 'string') return undefined;
    return text.startsWith(COMPACTION_SUMMARY_PREFIX) &&
      text.endsWith(COMPACTION_SUMMARY_SUFFIX)
      ? text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length)
      : text;
  }
  return undefined;
}

/**
 * 读 `settings.json` 的 `compaction.enabled`（默认 `true`，与 pi 同一个键）。
 *
 * settings 的读写按**域**分：模型作用域在 `model-scope.ts`、思考级别在 `thinking-level.ts`、
 * 压缩在这里 —— 同一个键在两处各读一遍，迟早有一处忘了校验或默认值，而「读了但值是错的」
 * 不报错，只表现成「我明明关了自动压缩，它还是压了」。
 */
export function readCompactionEnabled(cwd: string = process.cwd()): boolean {
  try {
    return SettingsManager.create(cwd, piAgentDir()).getCompactionEnabled();
  } catch {
    return true;
  }
}

/**
 * 写 `compaction.enabled`（`/settings` 面板里那一行）。
 *
 * async + `flush()` 的理由与 `writeHideThinkingBlock` 同一句：pi 的 `save()` 是入队异步写，
 * 不等它落盘，调用方紧接着读会读到旧值，而写失败也拿不到。
 */
export async function writeCompactionEnabled(
  enabled: boolean,
  cwd: string = process.cwd(),
): Promise<boolean> {
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    settings.setCompactionEnabled(enabled);
    await settings.flush();
    return settings.drainErrors().length === 0;
  } catch {
    return false;
  }
}

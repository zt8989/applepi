/**
 * `/session`（pi 同名命令：Show session info and stats）那张卡的内容。形状照抄 pi 的
 * `handleSessionCommand()`：会话信息（名称/文件/ID）、消息数、令牌、费用（按模型拆开）。
 *
 * 值得照抄：会话文件在哪、这一路花了多少 token 与钱都是**用户问不出别人**的事 —— 出问题时它决定
 * 「该去哪个文件里看」「这个月的账单是不是它烧的」。
 *
 * 两处**有意**不同：不印 `Cache Warming` 一节（本项目没有缓存预热，一个恒为 `Inactive` 的区块只是
 * 噪声）；数字来自 `state.messages`（**当前上下文**）而不是 sessionManager 的 entries —— 压缩之后
 * 老消息确实不在上下文里了，底栏的 `↑↓$` 也念同一份，两个数字对不上会让人以为算错了。
 */
import type { Message } from '@earendil-works/pi-ai';
import {
  addUsageToTotals,
  createUsageTotals,
} from '@earendil-works/pi-coding-agent/dist/core/usage-totals.js';
import { formatTokens } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';

/** 消息条数（与 pi 的 `Messages` 那一节同口径）。 */
export interface MessageCounts {
  total: number;
  user: number;
  assistant: number;
  /** assistant 消息里 `toolCall` 块的个数。 */
  toolCalls: number;
  /** `toolResult` 消息的条数。 */
  toolResults: number;
}

/**
 * Token 口径 —— **prompt 与输出分开**，因为它们不是一回事。
 *
 * `prompt = input + cacheRead + cacheWrite`：pi 的算法（`handleSessionCommand()` 里那一行），
 * 也就是「一共往模型嘴里送了多少 token」，其中命中缓存的那部分便宜得多。
 */
export interface TokenStats {
  /** 真的没命中缓存、按全价算的那部分（pi 把它与 `cacheWrite` 一起叫 Uncached）。 */
  input: number;
  output: number;
  /** 从缓存读出来的（便宜）。 */
  cacheRead: number;
  /** 写进缓存的（通常比全价还贵一点）。 */
  cacheWrite: number;
  /** `input + cacheRead + cacheWrite`。 */
  prompt: number;
  /** `prompt + output`。 */
  total: number;
  /** 缓存命中率（`cacheRead / prompt`，0~100）。没发过请求时 undefined。 */
  cacheHitRate?: number | undefined;
}

/** 一个模型的用量（费用那一节的「按模型拆开」）。 */
export interface ModelCost {
  /** `provider/model`。 */
  key: string;
  cost: number;
  tokens: number;
}

export interface SessionStats {
  messages: MessageCounts;
  tokens: TokenStats;
  /** 累计费用（美元；与底栏那个 `$` 同一份数据）。 */
  cost: number;
  /** 按模型分的费用，**贵的在前**（pi 的 `getUsageCostBreakdown()` 同一排序）。 */
  costByModel: ModelCost[];
}

/**
 * 从当前上下文里算出一份统计。
 *
 * 只念 `messages`：`totalCost` 那个累加器在**恢复会话**之后是 0（见 reducer 的
 * `totalCost`），拿它当会话累计会漏掉恢复之前那一段 —— 而消息里的 `usage` 是跟着消息
 * 一起读回来的，反而是全的。
 */
export function collectSessionStats(messages: readonly Message[]): SessionStats {
  const counts: MessageCounts = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0 };
  const totals = createUsageTotals();
  const byModel = new Map<string, { cost: number; tokens: number }>();

  for (const message of messages) {
    counts.total += 1;
    if (message.role === 'user') {
      counts.user += 1;
      continue;
    }
    if (message.role === 'toolResult') {
      counts.toolResults += 1;
      continue;
    }
    if (message.role !== 'assistant') continue;
    counts.assistant += 1;
    for (const block of message.content) {
      if (block.type === 'toolCall') counts.toolCalls += 1;
    }
    const usage = message.usage;
    if (!usage) continue;
    addUsageToTotals(totals, usage);
    const key = `${message.provider}/${message.responseModel ?? message.model}`;
    const bucket = byModel.get(key) ?? { cost: 0, tokens: 0 };
    bucket.cost += usage.cost.total;
    bucket.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    byModel.set(key, bucket);
  }

  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return {
    messages: counts,
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      prompt,
      total: prompt + totals.output,
      ...(prompt > 0 ? { cacheHitRate: (totals.cacheRead / prompt) * 100 } : {}),
    },
    cost: totals.cost,
    costByModel: [...byModel]
      .filter(([, bucket]) => bucket.cost > 0 || bucket.tokens > 0)
      .map(([key, bucket]) => ({ key, ...bucket }))
      .sort((a, b) => b.cost - a.cost),
  };
}

/** 卡片头部那三行（`/session` 从界面那边拿到的身份信息）。 */
export interface SessionCardInfo {
  /** 会话文件；`undefined` = 这个会话还没落过盘（pi 那句 `In-memory`）。 */
  file?: string | undefined;
  id: string;
  /** 用户起的名字（`session_info`）。没起过就不印那一行（与 pi 一致）。 */
  name?: string | undefined;
}

/**
 * 排版用的两个上色函数。
 *
 * 传进来而不是 import：`app.ts` 的 `dim` / `bold` 是那个模块的私有工具（还带着
 * `NO_COLOR` 的判断），而这个文件不许反向 import 界面 —— 那会成环。
 */
export interface SessionCardStyle {
  dim(text: string): string;
  bold(text: string): string;
}

/** 千分位。固定 en-US：终端里一堆 `1,234` 比跟着系统 region 变更好对账。 */
function num(value: number): string {
  return value.toLocaleString('en-US');
}

/** 把统计排成 `/session` 那张卡（纯文本，颜色由 `style` 给）。 */
export function formatSessionCard(
  stats: SessionStats,
  info: SessionCardInfo,
  style: SessionCardStyle,
): string {
  const { dim, bold } = style;
  const row = (label: string, value: string): string => `  ${dim(`${label}:`)} ${value}`;
  /** 第二级缩进（「缓存 / 未缓存」那种挂在一条下面的细分）。 */
  const sub = (label: string, value: string): string => `    ${dim(`${label}:`)} ${value}`;

  const lines: string[] = [];

  lines.push(bold('会话信息'));
  if (info.name !== undefined && info.name !== '') lines.push(row('名称', info.name));
  lines.push(row('文件', info.file ?? dim('（还没落盘：这个会话一条消息都还没发过）')));
  lines.push(row('ID', info.id));

  lines.push('');
  lines.push(bold('消息'));
  lines.push(row('总计', String(stats.messages.total)));
  lines.push(row('用户', String(stats.messages.user)));
  lines.push(row('助手', String(stats.messages.assistant)));
  lines.push(
    row('工具', `${stats.messages.toolCalls} 次调用，${stats.messages.toolResults} 个结果`),
  );

  const { tokens } = stats;
  lines.push('');
  lines.push(bold('令牌'));
  lines.push(row('输入', num(tokens.prompt)));
  if (tokens.cacheHitRate !== undefined && (tokens.cacheRead > 0 || tokens.cacheWrite > 0)) {
    lines.push(
      sub('缓存', `${num(tokens.cacheRead)} ${dim(`(${tokens.cacheHitRate.toFixed(1)}%)`)}`),
    );
    const uncached =
      num(tokens.input + tokens.cacheWrite) +
      (tokens.cacheWrite > 0 ? dim(`（其中 ${num(tokens.cacheWrite)} 写进缓存）`) : '');
    lines.push(sub('未缓存', uncached));
  }
  lines.push(row('输出', num(tokens.output)));
  lines.push(row('总计', num(tokens.total)));

  if (stats.cost > 0) {
    lines.push('');
    lines.push(bold('费用'));
    lines.push(row('总计', `$${stats.cost.toFixed(3)}`));
    // 只有一个模型时不拆 —— 那一段与上面那行数字完全一样，纯噪声（pi 同一条件）。
    if (stats.costByModel.length > 1) {
      for (const entry of stats.costByModel) {
        lines.push(
          `    ${dim(`${entry.key}:`)} $${entry.cost.toFixed(3)} ${dim(`（${formatTokens(entry.tokens)} tokens）`)}`,
        );
      }
    }
  }

  return lines.join('\n');
}

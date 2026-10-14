/**
 * 会话流（session stream）—— **从轨迹树派生的时间线**。
 *
 * ## 为什么要这一层
 *
 * 界面要画的是「这场对话发生过什么」。以前这个答案有两个来源：
 *
 *   - `state.messages` —— 发给模型的**那份历史**。它会被上下文压缩整段替换、
 *     会被恢复历史整批重灌，中途的 system 声明也混在里面；
 *   - 界面上各处自己记的临时提示（TUI 的 `statusCards`、WebUI 的顶部提示条）。
 *
 * 两个来源都不适合当「发生过什么」的真相：前者会被改写，后者不持久、
 * 两个界面各记一份（于是 WebUI 看不到 TUI 的提示，反之亦然）。
 *
 * 轨迹树才是那份真相：一次尝试一节点，只追加不改写，落盘、回放、恢复都是它。
 * 于是时间线从它派生 —— **一份派生逻辑，两个界面共用**。
 *
 * ## 派生规则
 *
 * 按 `tree.order`（= 发生顺序）走一遍，每个节点最多产出一条条目：
 *
 * | 节点 | 条目 |
 * | --- | --- |
 * | `user` / `llm.result` / `tool.result` / `prompt.segment` | `message`（节点自己带的 pi 消息） |
 * | 工具失败的 `error`（带 message） | `message`（那条 isError 的 toolResult） |
 * | LLM 失败的 `error` / `stop` | `notice`（红/黄/灰） |
 * | `model.changed` | `notice`（配置切换） |
 * | `compact` | `notice`（压缩） |
 * | 容器（`turn.*` / `step.*`）与 `tool.call` | 不产出（工具调用在助手消息里，结果由 toolResult 出） |
 * | `prompt.base` / `prompt.tools` / `prompt.skills` | 不产出（是上下文装载，不是对话） |
 *
 * ## 旧轨迹的退路
 *
 * 节点上的 `message` 是新加的字段。旧轨迹文件里消息单独落在 `op:'message'` 行、
 * 节点上没有它 —— 那时整体退回 `fallbackMessages`（内核从会话文件读回来的那份），
 * 行为与改动前一致。判据是「**所有**会产生消息的节点都带了 message 吗」，
 * 混合状态（一半有一半没有）也整体退回：半份派生出来的时间线比不派生更误导。
 *
 * ## 纯函数
 *
 * 没有 IO、没有 `Date.now()`。同一棵树必然产出同一份流。
 */
import type { Message } from '@earendil-works/pi-ai';
import type { TraceNode, TraceNodeKind, TraceTree } from './trace';
import { stopCauseText, type StopCause } from './state';

/** 提示的语气（决定颜色）。 */
export type StreamNoticeTone = 'error' | 'warn' | 'info' | 'config';

/** 一条「消息」条目 —— 内容就是节点自己带的那份 pi 消息。 */
export interface StreamMessageEntry {
  readonly kind: 'message';
  /** 稳定 key：节点 id（旧轨迹退路里是 `m<序号>`）。 */
  readonly id: string;
  /** 来源节点；旧轨迹退路里是 `null`。 */
  readonly nodeId: string | null;
  readonly message: Message;
}

/** 一条「提示」条目 —— 错误 / 收工 / 配置切换 / 压缩。 */
export interface StreamNoticeEntry {
  readonly kind: 'notice';
  readonly id: string;
  readonly nodeId: string;
  readonly tone: StreamNoticeTone;
  /** 一句主文案（已由内核翻成人话）。 */
  readonly title: string;
  /** 详细文本（技术错误原文 / 思考级别 / 摘要全文…）。 */
  readonly detail?: string | undefined;
}

export type StreamEntry = StreamMessageEntry | StreamNoticeEntry;

/** 会产生一条消息的节点种类。 */
const MESSAGE_KINDS: ReadonlySet<TraceNodeKind> = new Set<TraceNodeKind>([
  'user',
  'llm.result',
  'tool.result',
  'prompt.segment',
]);

const KNOWN_CAUSES: ReadonlySet<string> = new Set<StopCause>([
  'completed',
  'maxTurns',
  'user',
  'timeout',
  'network',
  'auth',
  'model',
  'llm-error',
  'tool-error',
  'shutdown',
  'compact-error',
]);

/** 从节点的 meta 里取停止原因（没有就返回 undefined）。 */
function causeOf(node: TraceNode): StopCause | undefined {
  const cause = node.meta?.['cause'];
  return cause !== undefined && KNOWN_CAUSES.has(cause) ? (cause as StopCause) : undefined;
}

/** 停止原因 → 语气：用户主动停是灰的（不是故障），撞上限是黄的，其余是红的。 */
function toneOfCause(cause: StopCause | undefined, status: TraceNode['status']): StreamNoticeTone {
  if (status === 'aborted' || cause === 'user' || cause === 'shutdown') return 'info';
  if (cause === 'maxTurns') return 'warn';
  return 'error';
}

function noticeOf(node: TraceNode): StreamNoticeEntry | undefined {
  switch (node.kind) {
    case 'error': {
      const cause = causeOf(node);
      return {
        kind: 'notice',
        id: node.id,
        nodeId: node.id,
        tone: toneOfCause(cause, node.status),
        title: cause !== undefined ? stopCauseText(cause) : node.label,
        detail: node.detail ?? node.label,
      };
    }
    case 'stop': {
      const cause = causeOf(node);
      return {
        kind: 'notice',
        id: node.id,
        nodeId: node.id,
        tone: toneOfCause(cause, node.status),
        title: cause !== undefined ? stopCauseText(cause) : node.label,
        detail: node.detail ?? node.label,
      };
    }
    case 'model.changed': {
      // 只把 `model.changed` 节点当配置提示（装载那条是 `model.init`，开头出现只是噪声）。
      const thinking = node.meta?.['thinking'];
      return {
        kind: 'notice',
        id: node.id,
        nodeId: node.id,
        tone: 'config',
        title: node.label,
        detail: thinking !== undefined ? `thinking: ${thinking}` : undefined,
      };
    }
    case 'compact': {
      return {
        kind: 'notice',
        id: node.id,
        nodeId: node.id,
        tone: 'info',
        title: node.label,
        detail: node.detail,
      };
    }
    default:
      return undefined;
  }
}

/**
 * 从轨迹树派生会话流。
 *
 * @param fallbackMessages 旧轨迹（节点上没有消息）时的退路 —— 通常是 `state.messages`。
 */
export function deriveStream(
  tree: TraceTree | undefined,
  fallbackMessages: readonly Message[] = [],
): StreamEntry[] {
  // 宽容 `undefined`：真实 state 里一定有 trace，但测试与一次性调用点可能没给。
  const order = tree?.order ?? [];
  const nodes = tree?.nodes ?? {};
  const messageNodes: TraceNode[] = [];
  for (const id of order) {
    const node = nodes[id];
    if (node !== undefined && MESSAGE_KINDS.has(node.kind)) messageNodes.push(node);
  }
  const allPayload =
    messageNodes.length > 0 && messageNodes.every((node) => node.message !== undefined);
  // 旧轨迹：消息没挂在节点上 —— 整体退回 `fallbackMessages`。
  // 但**提示还要从节点里派生**（旧轨迹里错误节点是有的）：不派生的话，恢复一个旧会话
  // 就再也看不到当时的失败了。位置只能排在消息之后（旧轨迹里拿不到准确的锚点）。
  if (!allPayload && fallbackMessages.length > 0) {
    const entries: StreamEntry[] = fallbackMessages.map((message, index) => ({
      kind: 'message',
      id: `m${index}`,
      nodeId: null,
      message,
    }));
    for (const id of order) {
      const node = nodes[id];
      if (node === undefined || MESSAGE_KINDS.has(node.kind)) continue;
      // 工具失败的 error 已经由 fallback 里那条 isError 的 toolResult 表现了，别报两遍。
      if (node.kind === 'error' && node.meta?.['tool'] !== undefined) continue;
      const notice = noticeOf(node);
      if (notice !== undefined) entries.push(notice);
    }
    return entries;
  }

  const entries: StreamEntry[] = [];
  for (const id of order) {
    const node = nodes[id];
    if (node === undefined) continue;
    if (MESSAGE_KINDS.has(node.kind)) {
      if (node.message !== undefined) {
        entries.push({ kind: 'message', id: node.id, nodeId: node.id, message: node.message });
      }
      continue;
    }
    // 工具失败的 error 节点带着那条 isError 的 toolResult —— 它是一条消息，不是提示。
    if (node.kind === 'error' && node.message !== undefined) {
      entries.push({ kind: 'message', id: node.id, nodeId: node.id, message: node.message });
      continue;
    }
    const notice = noticeOf(node);
    if (notice !== undefined) entries.push(notice);
  }
  return entries;
}

/** 只取消息条目（给「只想看对话」的调用方用）。 */
export function streamMessages(entries: readonly StreamEntry[]): Message[] {
  const out: Message[] = [];
  for (const entry of entries) {
    if (entry.kind === 'message') out.push(entry.message);
  }
  return out;
}

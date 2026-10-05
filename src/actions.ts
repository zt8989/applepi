import type {
  AssistantMessage,
  ImageContent,
  ModelThinkingLevel,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { LlmErrorKind } from './state';

/**
 * 一切皆 Action。
 *
 * Agent 不是一等公民：它只是 `agent.run` 这一个 Action，和 `tool.call`、
 * `user.message`、`llm.done` 完全平级。reducer 里没有任何 `if (kind === 'agent')`
 * 这类分支 —— 谁来执行 `agent.run`（自己调 pi-ai，还是别的什么东西）
 * 是**接线**的事，由 store 创建时注入的 effect 表决定。
 *
 * 环（用 action 名写出来就是全部）：
 *
 *   user.message → agent.run → llm.started → llm.delta* → llm.done
 *                                            ├─ 无工具 ─────────────────→ (idle)
 *                                            └─ 有工具 → tool.call → tool.start* →
 *                                               tool.result* → tool.batch.done → agent.run
 *
 * 失败与重试也写在环里：
 *
 *   llm.failed（可重试且还有次数）→ 相位仍 thinking → agent.run（同一 tip 下再开一个 attempt）
 *
 * 注意 `llm.done` 之后的 `tool.call` 也是一个 action：它由 reducer 的接线发出来，
 * 走的是同一条 dispatch 回流，而不是从 effect 里直接跳到工具执行。
 */
export type AgentAction =
  /**
   * 人说了什么。`content` 是可选的：Web 侧带附件时，adapter 会把附件折成
   * text/image content 块一起带进来，消息仍是标准的 pi-ai user 消息。
   */
  | {
      type: 'user.message';
      text: string;
      content?: (TextContent | ImageContent)[] | undefined;
    }
  /** 跑一轮对话（= 调一次 LLM）。谁执行由 effect 表决定。 */
  | { type: 'agent.run'; text?: string | undefined }
  /** LLM 文本增量（流式渲染）。 */
  | { type: 'llm.delta'; delta: string }
  /** LLM 思考增量。 */
  | { type: 'llm.thinking'; delta: string }
  /** 一次 LLM 调用开始（流还没吐字，UI 用它起「正在生成」动画）。 */
  | { type: 'llm.started' }
  /**
   * 一次 LLM 调用完成。`nodeId` 是这次尝试对应的轨迹节点（`llm.attempt`），
   * reducer 靠它把 `llm.result` 挂到正确的父节点下。
   */
  | { type: 'llm.done'; message: AssistantMessage; nodeId?: string | undefined }
  /**
   * LLM 调用失败（超时、网络、鉴权、模型错误）。`kind` 决定要不要重试；
   * `nodeId` 是这次尝试的轨迹节点，error 节点挂在它下面。
   */
  | {
      type: 'llm.failed';
      error: string;
      kind?: LlmErrorKind | undefined;
      nodeId?: string | undefined;
    }
  /** 重试用尽或不该重试：彻底收工，相位回 idle，并在树上留一个 stop/error 节点。 */
  | { type: 'llm.giveup'; error: string; kind: LlmErrorKind; nodeId?: string | undefined }
  /** 这些工具调用需要执行。 */
  | { type: 'tool.call'; calls: ToolCall[] }
  /** 一个工具开始执行。 */
  | { type: 'tool/start'; call: ToolCall }
  /** 一个工具出结果。 */
  | { type: 'tool.result'; message: ToolResultMessage }
  /** 一批工具跑完了。 */
  | { type: 'tool.batch.done'; count: number }
  /** 换了模型。 */
  | { type: 'model.changed'; provider: string; modelId: string }
  /** 换了思考级别。 */
  | { type: 'thinking.changed'; level: ModelThinkingLevel }
  /**
   * 轨迹节点已落盘。持久化是 effect（写文件 / localStorage），它把游标推回来，
   * 于是 reducer 知道自己已经写过哪一段，重复的记录不会二次落盘。
   */
  | { type: 'trace.persisted'; upToSeq: number }
  /** 清空对话。 */
  | { type: 'conversation.reset' };

export type AgentActionType = AgentAction['type'];

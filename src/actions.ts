import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

/**
 * 一切皆 Action。
 *
 * Agent 不是一等公民：它只是 `agent.run` 这一个 Action，和 `tool.call`、
 * `user.message`、`llm.done` 完全平级。reducer 里没有任何 `if (kind === 'agent')`
 * 这类分支 —— 谁来执行 `agent.run`（pi-ai 直接调、还是 pi-agent-core 的 Agent）
 * 是**接线**的事，由 store 创建时注入的 effect 表决定。
 *
 * 环（用 action 名写出来就是全部）：
 *
 *   user.message → agent.run → llm.delta* → llm.done
 *                                            ├─ 无工具 ─────────────────→ (idle)
 *                                            └─ 有工具 → tool.call → tool.start* →
 *                                               tool.result* → tool.batch.done → agent.run
 */
export type AgentAction =
  /** 人说了什么。 */
  | { type: 'user.message'; text: string }
  /** 跑一轮对话（= 调一次 LLM）。谁执行由 effect 表决定。 */
  | { type: 'agent.run'; text?: string | undefined }
  /** LLM 文本增量（流式渲染）。 */
  | { type: 'llm.delta'; delta: string }
  /** LLM 思考增量。 */
  | { type: 'llm.thinking'; delta: string }
  /** 一次 LLM 调用完成。 */
  | { type: 'llm.done'; message: AssistantMessage }
  /** LLM 调用失败（鉴权、网络、模型错误）。 */
  | { type: 'llm.failed'; error: string }
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
  /** 清空对话。 */
  | { type: 'conversation.reset' };

export type AgentActionType = AgentAction['type'];

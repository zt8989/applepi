import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

/**
 * Agent 的全部 action。reducer 只认这些；
 * Cmd.run 的 success/fail action creator 产出的也是它们。
 */
export type AgentAction =
  /** 用户输入一条消息（CLI dispatch）。 */
  | { type: 'prompt'; text: string }
  /** LLM 文本增量 —— 由 llm Cmd 执行中通过 Cmd.dispatch 中途回流（流式渲染用）。 */
  | { type: 'llm/delta'; delta: string }
  /** 思考（reasoning）增量，同上。 */
  | { type: 'llm/thinking'; delta: string }
  /** 一次 LLM 调用正常结束（Cmd.run 的 successActionCreator）。 */
  | { type: 'llm/done'; message: AssistantMessage }
  /** LLM Cmd 本身抛了异常（failActionCreator）。 */
  | { type: 'llm/failed'; error: string }
  /** 一个工具开始执行。 */
  | { type: 'tool/start'; call: ToolCall }
  /** 一个工具执行完毕，toolResult 已并入 messages。 */
  | { type: 'tool/result'; message: ToolResultMessage }
  /** 本批工具全部执行完 → 触发下一轮 LLM Cmd。 */
  | { type: 'tools/done'; count: number }
  /** 清空对话回到初始状态。 */
  | { type: 'reset' };

export type AgentActionType = AgentAction['type'];

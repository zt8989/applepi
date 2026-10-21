/**
 * 内核自己发的 pi **agent 生命周期事件**的形状。
 *
 * 单独成叶子模块，是为了让 `actions.ts` 与 `extension-host.ts` 都只依赖它：
 * 放进任一方都得让另一方反向 import（层就反了）。
 *
 * 只列本项目真的会发的（形状同 pi `ExtensionEvent` 里对应的那几个）：扩展会照着写
 * handler，列一个永远不会来的事件就是骗人。不在这里的：`session_start` /
 * `before_agent_start` / `tool_call` 由 `extension-host.ts` 直接 `runner.emit`，
 * `ui_prompt_start` / `ui_prompt_end` 由官方 `ExtensionRunner` 包 `ctx.ui` 时自己发。
 */
import type { Message } from '@earendil-works/pi-ai';

export type ExtensionLifecycleEvent =
  /** 一轮 agent 开始跑（相位从 idle 进入思考/工具执行）。 */
  | { type: 'agent_start' }
  /** 一轮 agent 结束（相位回到 idle）。`messages` 是同形的会话消息。 */
  | { type: 'agent_end'; messages: readonly Message[] }
  /** 环完全停下来（没有自动重试 / 压缩 / 排队接续）。 */
  | { type: 'agent_settled' }
  /** 一条消息定稿（目前只在助手消息定稿时发）。 */
  | { type: 'message_end'; message: Message }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  /** `isError` 与发给模型的那份结果同一判据。 */
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError: boolean }
  /** 模型变了（`/model` 切档时发）。 */
  | {
      type: 'model_select';
      model: { provider: string; id: string };
      previousModel: { provider: string; id: string };
      source: string;
    };

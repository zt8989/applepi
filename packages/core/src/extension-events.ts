/**
 * pi 的 **agent 生命周期事件**（本项目内核自己发的那些）—— 形状的唯一真相。
 *
 * ## 为什么单独一个文件
 *
 * 这个类型横跨三处，而它们在依赖图上互不相让：
 *
 *   - `actions.ts` —— 事件要作为 action 落进 store（于是进轨迹、可回放）；
 *   - `extension-host.ts` —— `emitLifecycle()` 按它把事件发给扩展；
 *   - `effects.ts` / `store.ts` / `kernel.ts` —— 执行现场要构造它。
 *
 * 定义在 `extension-host.ts` 里的话，`actions.ts` 就得反过来 import 扩展宿主（层反了）；
 * 定义在 `actions.ts` 里的话，扩展宿主又得 import actions。单独一个**叶子模块**让两边
 * 都只依赖它，谁也不 import 谁。
 *
 * ## 只列真的会发的
 *
 * 形状与 pi 的 `ExtensionEvent`（`pi-coding-agent` 的 `core/extensions/types.d.ts`）里
 * 对应的那几个一致，但**只列本项目真的会发的**：与其把 pi 那三十多个事件的联合类型搬过来，
 * 不如只留「这里发哪几个」。发不出的不列 —— 列了就是骗人（扩展会按它写 handler，
 * 等一个永远不会来的事件）。
 *
 * 不在这里的：`session_start` / `before_agent_start` / `tool_call` 由
 * `extension-host.ts` 直接 `runner.emit`（它们是官方路径的一部分），
 * `ui_prompt_start` / `ui_prompt_end` 由官方 `ExtensionRunner` 包 `ctx.ui` 时自己发。
 */
import type { Message } from '@earendil-works/pi-ai';

export type ExtensionLifecycleEvent =
  /** 一轮 agent 开始跑（相位从 idle 进入思考/工具执行）。 */
  | { type: 'agent_start' }
  /** 一轮 agent 结束（相位回到 idle）。`messages` 是当时的会话消息（与 pi 同形）。 */
  | { type: 'agent_end'; messages: readonly Message[] }
  /** 环完全停下来（没有自动重试 / 压缩 / 排队接续）。 */
  | { type: 'agent_settled' }
  /** 一条消息定稿（目前只在助手消息定稿时发）。 */
  | { type: 'message_end'; message: Message }
  /** 一个工具开始执行。 */
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  /** 一个工具执行结束（`isError` 与发给模型的那份结果同一判据）。 */
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError: boolean }
  /** 模型变了（`/model` 切档时发）。 */
  | {
      type: 'model_select';
      model: { provider: string; id: string };
      previousModel: { provider: string; id: string };
      source: string;
    };

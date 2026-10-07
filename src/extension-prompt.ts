/**
 * `before_agent_start` 的接线。
 *
 * ## 这个事件在本项目里能做什么、不能做什么
 *
 * pi 那边它是最重要的 prompt 注入点（改 `systemPromptOptions`、注入消息）。本项目
 * **不采信它的 prompt 改动** —— 我们的 system prompt 是**装载时**定下的
 * （`prompt.init`，见 `system-prompt.ts`），一轮对话中途换 prompt 会让已经发出的
 * `messages` 与 prompt 对不上，而 prompt-cache 的前缀整个作废。
 *
 * 那为什么还要发这个事件？两个理由：
 *
 * 1. **工具集**：`ask_user_question` 自带的协调器在 `before_agent_start` 里按
 *    `ctx.hasUI` 摘/装工具。不发这个事件它就**永远不会被调用** —— 那一刻它什么也不做，
 *    正好是本项目要的（见 `extension-tools.ts` 的 `applyActiveTools`）。
 * 2. **不调它 = 不违反契约**：扩展可能靠这个事件做别的事（记一次「轮开始」、
 *    换 provider…）。不发等于骗它「没这回事」，症状会出现在它内部的某个远端调用上，
 *    极难归因。
 *
 * ## 为什么自己调 handler，而不是用官方的 `emitBeforeAgentStart`
 *
 * 官方那个方法会用 `systemPromptOptions` **重建**整份 system prompt
 * （`buildSystemPrompt(options)`）。本项目没有那份可重拼的 options —— prompt 是装载时
 * 拼好的，只存了成品文本。于是自己按「这件事其实只需要 `ctx`」的事实调 handler：
 * 第一个扩展的协调器只读 `ctx.hasUI`，事件本身一个字段都不碰。
 *
 * handler 从 `loadExtensions()` 的返回值里按注册顺序抄出来（与官方
 * `snapshotEventHandlers` 同口径），不伸手进 runner 的 private 字段。
 *
 * ## 扩展的错误不许炸环
 *
 * 官方在每个 handler 外面包了 try/catch 并报给 `runner.onError`。我们也照做 ——
 * 扩展坏了不该把用户的对话带崩。
 */
import type { AgentStore } from './store';

/** 一个 `before_agent_start` handler（参数形状只用到这两个）。 */
export type BeforeAgentStartHandler = (
  event: { type: 'before_agent_start'; prompt: string; images: unknown[] },
  ctx: { hasUI: boolean; mode: 'tui'; cwd: string },
) => unknown | Promise<unknown>;

export interface BeforeAgentStartOptions {
  handlers: readonly BeforeAgentStartHandler[];
  store: AgentStore;
  text: string | undefined;
  hasUI: boolean;
  cwd: string;
  /** 扩展名 → 最近一次报错。默认打到 stderr（界面看不见，但这是启动期的怪）。 */
  onError?(extensionPath: string, message: string): void;
}

export async function notifyBeforeAgentStart(options: BeforeAgentStartOptions): Promise<void> {
  const { handlers, store, text, hasUI, cwd, onError } = options;
  if (handlers.length === 0) return;
  // 环在跑的时候不发：我们这个事件没有对应的一轮语义（pi 那边是「一次用户输入开始
  // 之前」，而本项目的轮是由 reducer 闭合的，见 effects.ts）。在工具调用的那一轮里发它
  // 等于告诉扩展「用户又说话了」—— 它若据此注入消息，消息就凭空多出来。
  if (store.getState().phase !== 'idle') return;

  const ctx = Object.freeze({ hasUI, mode: 'tui' as const, cwd });
  const event = Object.freeze({ type: 'before_agent_start' as const, prompt: text ?? '', images: [] });
  for (const handler of handlers) {
    try {
      await handler(event, ctx);
    } catch (error) {
      onError?.('before_agent_start', error instanceof Error ? error.message : String(error));
    }
  }
}

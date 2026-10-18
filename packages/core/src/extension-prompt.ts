/**
 * `before_agent_start` 的接线。
 *
 * ## 这个事件在本项目里能做什么、不能做什么
 *
 * pi 那边它是最重要的 prompt 注入点（改 `systemPromptOptions`、注入消息）。本项目的
 * system prompt 是**装载时**定下的（`prompt.init`，见 `system-prompt.ts`），**整段替换**
 * 不采信：一轮对话中途换整段 prompt 会让已经发出的 `messages` 与 prompt 对不上。
 *
 * **按段 patch 采信**：handler 往 `systemPromptOptions.sections` 里写的段会与「当前生效」
 * 那份 diff，只有变了的段进一条新的 system 消息（`prompt.segment.added`）——
 * 已有消息一个字节不动，前缀缓存因此能活下来。head 与 patch 的形状见 `prompt-head.ts`。
 *
 * 那为什么还要发这个事件？两个理由：
 *
 * 1. **工具集**：`ask_user_question` 自带的协调器在 `before_agent_start` 里按
 *    `ctx.hasUI` 摘/装工具。不发这个事件它就**永远不会被调用** —— 那一刻它什么也不做，
 *    正好是本项目要的（见 `extension-tools.ts` 的 `applyActiveTools`）。
 * 2. **不调它 = 不违反契约**：扩展可能靠这个事件做别的事（记一次「轮开始」、
 *    换 provider、改 prompt 段…）。不发等于骗它「没这回事」，症状会出现在它内部的某个
 *    远端调用上（或某个段再也不更新），极难归因。
 *
 * ## 为什么自己调 handler，而不是用官方的 `emitBeforeAgentStart`
 *
 * 官方那个方法会用 `systemPromptOptions` **重建**整份 system prompt
 * （`buildSystemPrompt(options)`）并把它整段塞进请求。本项目没有那份可重拼的 options ——
 * prompt 的**分段**存住了（`state.prompt.sections`），但整段是装载时定下的。于是自己跑一遍
 * handler：**采信** `sections` 的差异（转成按段 patch），**不采信**整段（`systemPrompt` /
 * `forceSystemPrompt` 一律忽略）。
 *
 * handler 从 `loadExtensions()` 的返回值里按注册顺序抄一份（与官方
 * `snapshotEventHandlers` 同口径），不伸手进 runner 的 private 字段。
 *
 * ## `ctx` 用**官方那个**（`runner.createContext()`），不手搓
 *
 * 早先这里给的是一个手搓的三字段 ctx（`hasUI` / `mode` / `cwd`），理由是「这条协调器
 * 只读 `ctx.hasUI`」。那个理由在 `pi-subagents` 面前就塌了：它的 handler 读
 * `ctx.sessionManager`（算会话身份与 subagent 产物目录），而手搓的 ctx 里那个字段是
 * `undefined` —— 症状是**每轮**一条 `Cannot read properties of undefined (reading
 * 'getSessionFile')`，且**一帧本项目的代码都没有**（炸点全在扩展自己那侧）。
 *
 * 官方 ctx 的每个成员都是本项目已经接好的真东西（`ctx.ui` / `ctx.model` /
 * `ctx.sessionManager` / `ctx.settings`…，见 extension-host.ts 的 bindCore），所以
 * 「官方 ctx」比「手搓的最小 ctx」既不更假、也不更容易崩：它只是**不装**。
 *
 * ## 事件字段：只给 handler 真的会读的，缺一个就每轮一条诊断
 *
 * `systemPromptOptions` 是官方那份 options 的**残缺版** —— 只给 `cwd` / `sections` /
 * `selectedTools`（谁会读、少一个会怎样，见下面那个字段的注释）。给多了（`skills` /
 * `toolSnippets` / `forceSystemPrompt`）才是有害的：那会让扩展以为它能重拼整份 prompt。
 *
 * 同一个理由适用于事件**顶层**的 `systemPrompt`：官方类型里它是必填的
 * （`readonly systemPrompt: string`），`pi-background-tasks` 的 shell 策略 handler 进来
 * 第一句就 `typeof event.systemPrompt !== 'string'` → 抛
 * `pi_bg_shell_prompt_unsupported`（症状：启动时一条「扩展装载诊断」，而它那段 shell
 * 指引永远进不了 prompt）。所以我们给**当时那份整段**（只读事实），但**不采信** handler
 * 返回的整段替换 —— 与下面 systemPromptOptions 同一个口径。
 *
 * ## 扩展的错误不许炸环
 *
 * 官方在每个 handler 外面包了 try/catch 并报给 `runner.onError`。我们也照做 ——
 * 扩展坏了不该把用户的对话带崩。
 */
import type { ExtensionContext } from '@earendil-works/pi-coding-agent/dist/core/extensions/types.js';
import { diffSystemPromptSections } from '@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import { effectiveSections } from './prompt-head';
import type { AgentStore } from './store';

/** 一个 `before_agent_start` handler（参数形状只用到这两个）。 */
export type BeforeAgentStartHandler = (
  event: {
    type: 'before_agent_start';
    prompt: string;
    images: unknown[];
    /**
     * 当时生效的**整段** system prompt（官方必填字段，扩展会拿它做校验/拼自己的块）。
     *
     * 只是**只读事实**：handler 返回的 `systemPrompt` 一律忽略（本项目的 prompt 是装载时
     * 定下的，整段替换会把已发出的 messages 与 prompt 弄对不上）。扩展真要改内容，走
     * `systemPromptOptions.sections`（按段 patch，见文件头）。
     */
    readonly systemPrompt: string;
    /**
     * 官方的 `BuildSystemPromptOptions`。**只给 handler 真的会读的那三个字段**：
     *
     * - `sections`：MCP 的 handler 往里写 `mcp_servers` —— 少了这个字段它会抛
     *   `Cannot read properties of undefined`（每轮一条诊断）。
     * - `selectedTools`：**给真的**（当前声明给模型的工具名）。`pi-subagents` 的主
     *   handler 第一句就是 `event.systemPromptOptions.selectedTools.includes('subagent')`
     *   —— 少这个字段的症状同样是每轮一条诊断，只是那句是
     *   `Cannot read properties of undefined (reading 'includes')`。
     *   它是**只读事实**，不是「可重拼的 options」：我们只拿它给 handler 读，不读回
     *   列表的变化（`tool-activation` 一边 push 一边调 `pi.setActiveTools()` ——
     *   真正生效的是后者，见 `extension-tools.ts`）。给一份可写的副本只为别让它们
     *   炸在 `push` 上。
     * - `cwd`。
     *
     * 其余字段（`skills` / `toolSnippets` / `forceSystemPrompt`…）故意不给：本项目不采信
     * handler 对 prompt 的修改（prompt 是装载时拼好的），给一份假的 options 只会让扩展
     * 以为它能重拼整份 prompt。
     */
    systemPromptOptions: {
      cwd: string;
      sections: Record<string, string>;
      selectedTools: string[];
    };
  },
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

export interface BeforeAgentStartOptions {
  handlers: readonly BeforeAgentStartHandler[];
  store: AgentStore;
  text: string | undefined;
  /** 事件里 `systemPromptOptions.cwd` 用的值（与 `ctx.cwd` 同一个）。 */
  cwd: string;
  /**
   * 交给 handler 的上下文 —— **官方那个**（`runner.createContext()`）。
   *
   * 不给一份手搓的最小 ctx：扩展会读它自己的字段（`ctx.sessionManager` /
   * `ctx.model`…），缺一个就是每轮一条诊断（理由见文件头）。
   */
  ctx: ExtensionContext;
  /**
   * 当前**声明给模型**的工具名（`selectedTools` 的真身）。
   *
   * 由宿主从 state 读（`activeToolsFromState`，与扩展自己调 `pi.getActiveTools()` 走
   * 同一个函数 —— 两边不会各说一份）。不给的话 `pi-subagents` 每轮报一条
   * `Cannot read properties of undefined (reading 'includes')`。
   */
  selectedTools: readonly string[];
  /** 扩展名 → 最近一次报错。默认打到 stderr（界面看不见，但这是启动期的怪）。 */
  onError?(extensionPath: string, message: string): void;
}

/**
 * 给每个 handler 一个 `before_agent_start`，把它们**写回**的 sections 差异拿出来。
 *
 * ## 返回值：只含**变了的段**的 patch
 *
 * handler 拿到的 `sections` 起点是**装载时那份**（不含别的 handler 已写过的段）；
 * diff 的基线是**当前生效**那一份（装载时那份 + 已追加过的 patch，见 `effectiveSections`）。
 * 两个起点不同不是口误 —— 与 pi 一致：handler 每轮得把自己维护的段重申一遍
 * （MCP 就每轮重写 `mcp_servers`），某一轮不再写就等于「不要那段了」（diff 出 `null`）；
 * 而基线必须含已追加的 patch，否则每轮都会把同一个旧值当成新变更，
 * **每轮多一条一模一样的补丁消息**。
 *
 * ## `sections` 为什么要抄一份
 *
 * 给 handler 的就是我们自己的对象，它们就地改 —— 只有抄一份，才能拿「改前」去 diff。
 */
export async function notifyBeforeAgentStart(
  options: BeforeAgentStartOptions,
): Promise<Record<string, string | null> | undefined> {
  const { handlers, store, text, cwd, ctx, selectedTools, onError } = options;
  if (handlers.length === 0) return undefined;
  // 环在跑的时候不发：我们这个事件没有对应的一轮语义（pi 那边是「一次用户输入开始
  // 之前」，而本项目的轮是由 reducer 闭合的，见 effects.ts）。在工具调用的那一轮里发它
  // 等于告诉扩展「用户又说话了」—— 它若据此注入消息，消息就凭空多出来。
  if (store.getState().phase !== 'idle') return undefined;

  const state = store.getState();
  const baseline = effectiveSections({
    systemPrompt: state.prompt.systemPrompt,
    ...(state.prompt.sections !== undefined ? { sections: state.prompt.sections } : {}),
    messages: state.messages,
  });
  const event = Object.freeze({
    type: 'before_agent_start' as const,
    prompt: text ?? '',
    images: [],
    // 官方的必填字段（`pi-background-tasks` 拿它做形状校验，缺了就抛
    // `pi_bg_shell_prompt_unsupported`）。给装载时那份整段 —— 它不含后续补丁段，
    // 但那是**当时真实**的一份；扩展若据此重写整段，我们也不采信（见上面的字段注释）。
    systemPrompt: state.prompt.systemPrompt,
    // 起点是**装载时那份**（不含别的 handler 已写过的段）：于是「某一轮不写某个段」
    // 表达的就是「不要那段了」，而不是「继承上一轮的值」。抄一份是因为 handler 就地改。
    systemPromptOptions: {
      cwd,
      sections: { ...(state.prompt.sections ?? {}) },
      selectedTools: [...selectedTools],
    },
  });
  for (const handler of handlers) {
    try {
      await handler(event, ctx);
    } catch (error) {
      onError?.('before_agent_start', error instanceof Error ? error.message : String(error));
    }
  }
  // 某个段被设成 `undefined`（不是 `null`）既不是「文本」也不是「删除」的官方写法，
  // 过滤掉：不把 `undefined` 写进要落盘的 payload。
  const desired: Record<string, string> = {};
  for (const [name, content] of Object.entries(event.systemPromptOptions.sections)) {
    if (typeof content === 'string') desired[name] = content;
  }
  return diffSystemPromptSections(baseline, desired);
}

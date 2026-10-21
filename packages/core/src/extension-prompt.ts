/**
 * `before_agent_start` 的接线。
 *
 * 整段 system prompt **不采信**：它是装载时定下的（`prompt.init`），一轮中途换整段会让
 * 已经发出的 `messages` 与 prompt 对不上。**按段 patch 采信**：handler 写进
 * `systemPromptOptions.sections` 的段与「当前生效」那份 diff，只有变了的段进一条新的
 * system 消息（`prompt.segment.added`），已有消息一个字节不动、前缀缓存能活下来。
 *
 * 那为什么还要发这个事件：`ask_user_question` 自带的协调器在 `before_agent_start` 里按
 * `ctx.hasUI` 摘/装工具，不发它就永远不会被调用；而扩展可能靠它做别的事，不发等于骗它
 * 「没这回事」。
 *
 * 自己调 handler 而不用官方的 `emitBeforeAgentStart`：后者会用 `systemPromptOptions`
 * **重建**整份 prompt 整段塞进请求，而本项目没有那份可重拼的 options。
 *
 * `ctx` 用**官方那个**（`runner.createContext()`），不手搓：`pi-subagents` 的 handler 读
 * `ctx.sessionManager`，手搓的 ctx 里那个字段是 undefined，症状是**每轮**一条
 * `Cannot read properties of undefined (reading 'getSessionFile')`，且炸点全在扩展自己那侧。
 *
 * 扩展的错误不许炸环：每个 handler 外面包 try/catch 并报给 `onError`。
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
     * 当时生效的**整段** system prompt（官方必填字段，扩展会拿它做形状校验）。
     *
     * 只是**只读事实**：handler 返回的 `systemPrompt` 一律忽略。扩展真要改内容，走
     * `systemPromptOptions.sections`（按段 patch，见文件头）。
     */
    readonly systemPrompt: string;
    /**
     * 官方的 `BuildSystemPromptOptions`，但**只给 handler 真的会读的那三个字段**：
     *
     * - `sections`：MCP 的 handler 往里写 `mcp_servers`，少了就每轮一条
     *   `Cannot read properties of undefined`。
     * - `selectedTools`：`pi-subagents` 的 handler 第一句就 `.includes('subagent')`，少了同样
     *   每轮一条诊断。它是**只读事实**（给副本只为别让它们炸在 `push` 上），真正生效的是
     *   它们随后调的 `pi.setActiveTools()`。
     * - `cwd`。
     *
     * 其余字段（`skills` / `toolSnippets` / `forceSystemPrompt`…）故意不给：本项目不采信
     * handler 对 prompt 的修改，给一份假 options 只会让它以为能重拼整份 prompt。
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
   * 交给 handler 的上下文 —— **官方那个**（`runner.createContext()`）。手搓的话扩展读
   * 它自己的字段（`ctx.sessionManager` / `ctx.model`…）就是每轮一条诊断（见文件头）。
   */
  ctx: ExtensionContext;
  /**
   * 当前**声明给模型**的工具名（`selectedTools` 的真身），由宿主从 state 读
   * （`activeToolsFromState`，与扩展调 `pi.getActiveTools()` 同一个函数）。
   */
  selectedTools: readonly string[];
  /** 扩展名 → 最近一次报错。默认打到 stderr（界面看不见，但这是启动期的怪）。 */
  onError?(extensionPath: string, message: string): void;
}

/**
 * 给每个 handler 一个 `before_agent_start`，把它们**写回**的 sections 差异拿出来。
 *
 * 返回值只含**变了的段**。handler 拿到的 `sections` 起点是**装载时那份**（不含别的 handler
 * 已写过的段），而 diff 的基线是**当前生效**那一份（装载时那份 + 已追加的 patch）——
 * 与 pi 一致：handler 每轮得把自己维护的段重申一遍，某一轮不再写就等于「不要那段了」
 * （diff 出 `null`）；基线若不含已追加的 patch，每轮都会把同一个旧值当新变更，
 * **每轮多一条一模一样的补丁消息**。
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
    // 官方必填字段（`pi-background-tasks` 拿它做形状校验，缺了就抛
    // `pi_bg_shell_prompt_unsupported`）。给的是**当时真实**那份（只是不含后续补丁段）；
    // 扩展据此重写整段也不采信。
    systemPrompt: state.prompt.systemPrompt,
    // 起点是**装载时那份**：于是「某一轮不写某个段」表达的就是「不要那段了」。抄一份是因为
    // handler 就地改。
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

/**
 * webui ↔ tui 的**线协议**。
 *
 * ## 为什么要有一份独立的协议文件
 *
 * 浏览器那一侧要用 `@earendil-works/pi-web-ui` 的 `ChatPanel`/`AgentInterface`，它们
 * 只认一个 `pi-agent-core` 形状的 `Agent`（`state` / `subscribe` / `prompt` / `abort`）。
 * 而本项目的环在 **tui 这一侧的内核**里跑（Redux Loop），不在浏览器里。
 *
 * 所以两头都得知道同一份「什么算状态、什么算事件」——那就是本文件。它只定义**形状**，
 * 不含任何逻辑，谁都能引：
 *
 *   - tui：`web/bridge.ts` 把内核的 `AgentState` 映射成这里的形状往外发；
 *   - webui：浏览器里那个 `RemoteAgent` 把收到的形状装回 `Agent` 的样子。
 *
 * ## 为什么不直接复用 pi-agent-core 的类型
 *
 * `WebAgentState` / `WebAgentEvent` 刻意与 pi-agent-core 的 `AgentState` / `AgentEvent`
 * **同一个口径**（角色的名字、事件的种类都一样），但不直接引它：那个包是浏览器侧的
 * 对端，tui 引它会把「前端」拖进服务端的依赖里。这里只引 pi-ai 的**消息类型**
 * （那是真的线上要传的东西）。
 */

import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';

/** 协议版本。对不上就拒绝连接 —— 比半懂不懂地解析强。 */
export const WEB_PROTOCOL_VERSION = 2;

/**
 * 列表里的一条模型（**紧凑投影**，不是整份 `Model`）。
 *
 * ## 为什么不在线协议里传整份 Model
 *
 * 目录里有四百多条（本机是 436），整份序列化 ~250KB；而选择器真正用到的只有
 * 「provider / id / 名字 / 能不能思考」。当前模型仍是**整份**（在 `state.model`）——
 * 那是要显示在输入框底下、要打得开模型详情的那一个。
 */
export interface WebModelRef {
  provider: string;
  id: string;
  name: string;
  /** 支持思考（理论上限不是 `off`）—— 与 TUI 面板上的标记同一个口径。 */
  reasoning: boolean;
}

/**
 * 浏览器侧 `session.state` 的形状（pi-web-ui 真的会读的字段）。
 *
 * 与 pi-agent-core 的 `AgentState` 是同一口径，但**只有界面上真的用到的那些**：
 * `isStreaming` 决定输入框能不能发；`streamingMessage` 喂流式容器；
 * `pendingToolCalls` 把工具卡标成「跑着」；`messages` 是稳定列表。
 */
export interface WebAgentState {
  /** 当前会话 id（`/new` 之后会变）。 */
  sessionId: string;
  /** 工具的工作目录（界面上显示用）。 */
  cwd: string;
  /** 发给模型的对话历史（user / assistant / toolResult）。 */
  messages: Message[];
  /** 当前模型对象（pi-ai 的 `Model`，可直接 JSON 传）。没解析出来时为 `null`。 */
  model: Model<Api> | null;
  /** 思考级别（pi-ai 的 `ModelThinkingLevel` 名字）。 */
  thinkingLevel: string;
  /** 环在跑（`phase !== 'idle'`）。 */
  isStreaming: boolean;
  /** 流式中的部分助手消息 —— pi-web-ui 的流式容器渲染它。 */
  streamingMessage: AssistantMessage | null;
  /** 正在执行的工具调用 id（pi-web-ui 用它把工具卡标成「跑着」）。 */
  pendingToolCalls: string[];
  /** 最近一次失败/中止的错误文本，没有就是 `null`。 */
  errorMessage: string | null;
  /** 工具名（展示用）。 */
  toolNames: string[];
}

/**
 * 服务端 → 浏览器的事件。
 *
 * 种类与 pi-agent-core 的 `AgentEvent` 对齐 —— `AgentInterface` 的 `subscribe`
 * 就是按这些 `type` 分支的（见 pi-web-ui 的 `components/AgentInterface.js`）。
 */
export type WebAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end' }
  | { type: 'turn_start' }
  | { type: 'message_start'; message: AssistantMessage }
  | { type: 'message_update'; message: AssistantMessage }
  | { type: 'message_end'; message: AssistantMessage };

/** 服务端 → 浏览器的消息。 */
export type WebServerMessage =
  | {
      type: 'hello';
      version: number;
      state: WebAgentState;
      /**
       * 可选的模型目录 —— **与 TUI 的 `/model` 面板同一份**（内核的
       * `ModelRuntime.getAvailableSnapshot()`，即「已配置的 provider 里那些」）。
       *
       * 不用 pi-web-ui 自带那份：那是它打包进去的一代 pi-ai 的内置目录（1500+，
       * 含大量本机根本没配的 provider），与内核能真发出去的模型对不上。
       */
      models: WebModelRef[];
      /**
       * 作用域（`settings.json` 的 `enabledModels`）。`null` = 全开。
       *
       * 与 TUI 同一个口径：**有作用域时面板默认只看作用域内**。
       */
      scopedModelIds: string[] | null;
      /** 开场诊断（装了哪些扩展、装载失败等）—— 直接显示在对话区上方。 */
      notices: string[];
    }
  | { type: 'state'; state: WebAgentState }
  | { type: 'event'; event: WebAgentEvent }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

/** 浏览器 → 服务端的消息。 */
export type WebClientMessage =
  | { type: 'prompt'; text: string }
  | { type: 'abort' }
  | { type: 'setModel'; provider: string; id: string }
  | { type: 'setThinking'; level: string }
  | { type: 'newSession' };

/** 把线协议消息解析成客户端消息；形状不对就返回 `undefined`（不认识的一律忽略）。 */
export function parseClientMessage(raw: string): WebClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const type = (value as { type?: unknown }).type;
  switch (type) {
    case 'prompt': {
      const text = (value as { text?: unknown }).text;
      return typeof text === 'string' ? { type: 'prompt', text } : undefined;
    }
    case 'abort':
      return { type: 'abort' };
    case 'setModel': {
      const provider = (value as { provider?: unknown }).provider;
      const id = (value as { id?: unknown }).id;
      return typeof provider === 'string' && typeof id === 'string'
        ? { type: 'setModel', provider, id }
        : undefined;
    }
    case 'setThinking': {
      const level = (value as { level?: unknown }).level;
      return typeof level === 'string' ? { type: 'setThinking', level } : undefined;
    }
    case 'newSession':
      return { type: 'newSession' };
    default:
      return undefined;
  }
}
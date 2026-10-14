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

/**
 * 协议版本。对不上就拒绝连接 —— 比半懂不懂地解析强。
 *
 * v3：`hello` 不再塞模型目录 / 作用域 —— 那些（以及命令表这类非会话数据）改成
 * HTTP 接口（`/api/*`，见 [api.ts](@ela/tui 的 web/api.ts)），前端按需取。
 */
export const WEB_PROTOCOL_VERSION = 3;

/**
 * 聊天流里「提示」条目用的合成消息 role。
 *
 * 它只存在于**线协议**上（浏览器渲染用），不进内核的 `messages`、更不会发给模型。
 * 定义在这里（而不是 `stream.ts`）是因为它是**线协议**的概念：bridge 发一个 role、
 * webui 注册同一个 —— 两端都从这里取，免得各写一份。
 */
export const STREAM_NOTICE_ROLE = 'ela-notice';

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
 * 聊天流里的一条**提示**（合成消息）—— 错误 / 收工 / 配置切换 / 压缩。
 *
 * 它由 trace 派生（见 `@ela/core/stream`），只活在**线协议**上：浏览器注册一个自定义
 * renderer 把这个 role 画成一张卡。它不进内核的 `messages`、更不会发给模型。
 */
export interface WebStreamNotice {
  readonly role: typeof STREAM_NOTICE_ROLE;
  readonly tone: 'error' | 'warn' | 'info' | 'config';
  readonly title: string;
  readonly detail?: string | undefined;
  readonly timestamp: number;
}

/** 列表里的一条：真正的 pi 消息，或者一条提示。 */
export type WebStreamItem = Message | WebStreamNotice;

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
  /**
   * 发给模型的对话历史（user / assistant / toolResult），**从轨迹派生**，
   * 并按锚点把提示条目插在正确的消息之间。
   */
  messages: WebStreamItem[];
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

// ─────────────────────────────────────────────────────────────────────────────
// 非会话数据的 HTTP 接口（`/api/*`）
//
// 这些**不进** WebSocket：它们与「环跑到哪一步」无关，按需取就行。放 HTTP 是为了
// 让前端不必把服务端的事实抄一份（模型目录、命令表、作用域、settings 都在服务端）。
// 形状定义在这里，因为它与线协议一样是**前后端唯一共同语言**。
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/commands` 里的一条：`/` 补全下拉念它。 */
export interface WebCommandInfo {
  name: string;
  description: string;
  /** 内置还是扩展注册的。 */
  source: 'builtin' | 'extension';
}

/** `GET /api/models`：目录 + 作用域 + 当前模型（选择器要置顶 + 打勾）。 */
export interface WebModelsInfo {
  models: WebModelRef[];
  /** `settings.json` 的 `enabledModels`；`null` = 全开。 */
  scoped: string[] | null;
  current: { provider: string; id: string } | null;
}

/** `GET /api/skills`：进了 prompt 的 skill 清单（不是磁盘上的全集）。 */
export interface WebSkillInfo {
  name: string;
  scope: string;
  description: string;
  filePath: string;
}

/** `GET /api/thinking`：当前档位 + 这个模型支持哪几档 + 默认档。 */
export interface WebThinkingInfo {
  current: string;
  levels: string[];
  default: string;
}

/** `GET /api/settings`。 */
export interface WebSettingsInfo {
  /** 自动压缩开关；`null` = 这个装配不支持（不显示那一行）。 */
  autoCompact: boolean | null;
  hideThinking: boolean;
  defaultThinkingLevel: string;
}

/** `GET /api/hotkeys`：**终端界面**的键位表（浏览器里只当参考看）。 */
export interface WebHotkeysInfo {
  lines: string[];
}

/** `POST /api/*` 的回执。 */
export interface WebActionResult {
  ok: boolean;
  message?: string | undefined;
}

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
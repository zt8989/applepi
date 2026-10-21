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
import type { QuestionnaireIntent, QuestionnaireSnapshot } from './questionnaire';

/**
 * 协议版本。对不上就拒绝连接 —— 比半懂不懂地解析强。
 *
 * v3：`hello` 不再塞模型目录 / 作用域 —— 那些（以及命令表这类非会话数据）改成
 * HTTP 接口（`/api/*`，见 [api.ts](@ela/tui 的 web/api.ts)），前端按需取。
 *
 * v4：问卷（`ui-questionnaire` / `ui-questionnaire-intent`）—— 多题 tab 那种提问的
 * 整份快照与意图。加消息种类也算"对不上就拒绝"（旧前端收到不认识的帧会当未知消息），
 * 所以版本号跟着走。
 *
 * v5：`prompt` 带附件（`attachments`）—— 浏览器把图片 / 文档折成 content 块发给内核。
 * 旧前端不知道这个字段，带附件的消息会**静默丢掉附件**；所以版本号跟着走。
 */
export const WEB_PROTOCOL_VERSION = 5;

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
 * 浏览器侧传上来的一份附件（对应 pi-web-ui 的 `Attachment`）。
 *
 * ## 为什么文档只带 `extractedText`
 *
 * 模型要的是可读文本，不是那份二进制；而 `content`（原文件的 base64）会跟着 WS 帧
 * 传一遍、再被内核写进会话文件 —— 一份 10MB 的 PDF 变成几十 MB 的轨迹。图片不同：
 * 模型**真的**要看图，所以 `content` 必须带上（它就是 `ImageContent.data`）。
 *
 * `preview` 只有界面用（PDF 首页缩略图），服务端不需要 —— 所以这里不传。
 */
export interface WebAttachment {
  id: string;
  type: 'image' | 'document';
  fileName: string;
  mimeType: string;
  /** 原文件字节数（界面显示用）。 */
  size: number;
  /** 图片的 base64（不含 data URL 前缀）；文档为空串。 */
  content: string;
  /** 文档抽出来的正文（图片没有）。 */
  extractedText?: string | undefined;
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
   * 底栏那一行工作目录（与 TUI 的 `cwdLine()` **逐字同形**）：`~/proj (main)`，
   * 家目录缩成 `~`、括号里是 git 分支（不在仓库里就没有括号）。
   *
   * 为什么由服务端算而不是浏览器拼：`~` 要**服务端的家目录**才缩得对，而分支要读
   * `.git/HEAD`（浏览器碰不到文件系统）。与 `statsText` 同一个理由 —— 两套算法各写
   * 一份，口径迟早会漂（终端与浏览器显示同一个会话的两个目录形状）。
   */
  cwdText: string;
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
  /**
   * 每个工具调用的耗时（`toolCallId` → 毫秒）—— 工具卡上那个 `1.2s`。
   *
   * 取自内核的 `state.toolTimings`。
   *
   * ## 为什么不让浏览器自己计时
   *
   * 工具在**服务端**跑，浏览器只看到「开始 / 结束」两条消息 —— 拿这两个时刻相减，
   * 算进去的是**传输延迟 + 渲染延迟**，而不是命令本身跑了多久。恢复历史时更糟：
   * 早跑完的工具连「开始」那条消息都没有。reducer 那边（`tool/start` / `tool.result`）
   * 是唯一同时拿得到开始时刻与结束时刻的地方。
   */
  toolTimings: Record<string, number>;
  /**
   * 底栏那一行统计（与 TUI 的 `statsLine()` **逐字同形**）：
   * `↑362k ↓310k R121M CH99.9% 52%/1.0M (auto)`（末尾 `(auto)` = 自动压缩开着）。
   *
   * 为什么由服务端算而不是浏览器自己算：`CH`（缓存命中率）与上下文占用两段的口径都是
   * 「最近一次有效调用」，且上下文窗口要从 `model.contextWindow` 取 —— 在 `statsLine()`
   * 里定下之后，两边各自再算一份必漂。
   */
  statsText: string;
  /** 统计行的告警级别（上下文占用 >70% = `warn`、>90% = `error`）。 */
  statsLevel: 'none' | 'warn' | 'error';
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
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  /**
   * 扩展要弹一个原生对话框（`ctx.ui.select/confirm/input`）—— 与终端**各出一份**，
   * 谁先回答谁算数（见 `@ela/core/extension-ui` 的 `raceDialog`）。
   *
   * 发给了**所有**连接：随便哪个标签页回答都算。
   */
  | {
      type: 'ui-request';
      id: string;
      method: 'select' | 'confirm' | 'input';
      title: string;
      /** `select` 的选项。 */
      options?: string[];
      /** `confirm` 的正文。 */
      message?: string;
      /** `input` 的占位符。 */
      placeholder?: string;
    }
  /** 关掉那个弹窗（另一端先答了 / 整轮被中断）。客户端收到就静默关掉。 */
  | { type: 'ui-cancel'; id: string }
  /**
   * 一份**问卷**（多题 tab）的整份快照。与 `ui-request` 不同：它不是"一问一答"，
   * 而是服务端持一份状态（`@ela/core/questionnaire`），浏览器与终端是它的**两块屏幕**。
   *
   * 每次变化都重发整份快照而不是增量：一份问卷就一屏内容（4 题 × 4 选项），
   * 增量协议的复杂度换不来什么，而整份快照让"后开的标签页"天然是对的。
   */
  | { type: 'ui-questionnaire'; id: string; snapshot: QuestionnaireSnapshot }
  /** 问卷结束（提交 / 取消 / 拆台）。客户端收到就把那个弹窗撤掉。 */
  | { type: 'ui-questionnaire-close'; id: string };

/** 浏览器 → 服务端的消息。 */
export type WebClientMessage =
  /**
   * 人说一句话（可带附件）。
   *
   * `text` 可以是空串（只发附件）；`attachments` 缺省 = 纯文本。桥会把它们折成
   * `user.message` 的 content 块（图片 → image 块，文档 → 带文件名头的 text 块）。
   */
  | { type: 'prompt'; text: string; attachments?: WebAttachment[] }
  | { type: 'abort' }
  | { type: 'setModel'; provider: string; id: string }
  | { type: 'setThinking'; level: string }
  | { type: 'newSession' }
  /**
   * 恢复一个历史会话（侧边栏里点一条）。
   *
   * **只传 id + cwd**，不传文件路径：路径由服务端自己拼（`findSessionFile`）——
   * 浏览器拿不到、也不需要知道磁盘布局。
   */
  | { type: 'resumeSession'; id: string; cwd: string }
  /**
   * 回答一个 `ui-request`。`value` 的义：`select` = 选中的选项；`input` = 文本；
   * `confirm` = `'yes'` / `'no'`。取消（关掉弹窗）给 `cancelled: true`。
   */
  | { type: 'ui-response'; id: string; value?: string; cancelled?: boolean }
  /**
   * 问卷里的一个动作（切题 / 勾选 / 输入 / 提交 / 放弃）。
   *
   * 只推**意图**，不推状态：状态只有服务端一份，两边算的话必然漂（与底栏统计行
   * 同一个理由）。
   */
  | { type: 'ui-questionnaire-intent'; id: string; intent: QuestionnaireIntent };

// ─────────────────────────────────────────────────────────────────────────────
// 非会话数据的 HTTP 接口（`/api/*`）
//
// 这些**不进** WebSocket：它们与「环跑到哪一步」无关，按需取就行。放 HTTP 是为了
// 让前端不必把服务端的事实抄一份（模型目录、命令表、作用域、settings 都在服务端）。
// 形状定义在这里，因为它与线协议一样是**前后端唯一共同语言**。
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /api/sessions` 里的一条：侧边栏列表要的**紧凑投影**。 */
export interface WebSessionRef {
  id: string;
  /** 会话自己的工作目录 —— 侧边栏按它分组（「历史 cwd 的会话」）。 */
  cwd: string;
  /** 列表里那行文字：用户起的名字，没有就用第一句话，再没有就用 id。 */
  title: string;
  /** 最后一次说话的时间（ms）—— 排序与「多久之前」用它。 */
  lastActivityMs: number;
  /** 消息条数（数行数，不解析）。 */
  messageCount: number;
  /**
   * 归档时刻（ms）—— 只有 `GET /api/sessions/archived` 会给。
   *
   * 主列表（`GET /api/sessions`）里**不会有**带这个字段的条目：归档的那些不在其中，
   * 它们的份数在 `archivedCount` 里。
   */
  archivedAt?: number | undefined;
}

/**
 * `GET /api/sessions`：侧边栏要的那份列表（按 cwd 分组是前端的事）。
 *
 * `sessions` **不含**已归档的会话；它们要走 `GET /api/sessions/archived`（归档视图
 * 才需要那份明细，所以不跟着主列表一起算）。`archivedCount` 是底部「已归档 · N」
 * 那个入口要的数，只数**还存在的**会话 —— 文件被手工删掉的不该把数撑大。
 */
export interface WebSessionsInfo {
  sessions: WebSessionRef[];
  archivedCount: number;
}

/**
 * `POST /api/sessions/delete` 的结果。
 *
 * `failed` 不抛错：Windows 上文件可能被占着，删一批时让用户看到「删了 12 个、1 个
 * 没删掉」比整个请求失败有用（与 `cleanSessions` 同一口径）。
 */
export interface WebSessionDeleteInfo {
  ok: boolean;
  /** 真的删掉的会话 id。 */
  deleted: string[];
  /** 没删掉的：`<id>` 与原因。 */
  failed: { id: string; reason: string }[];
  /** 一句给用户看的说明（当前会话被跳过、正在跑那一回合被拒之类）。 */
  message?: string | undefined;
}

/** `GET /api/commands` 里的一条：`/` 补全下拉念它。 */
export interface WebCommandInfo {
  name: string;
  description: string;
  /** 内置 / 扩展注册 / prompt 模板 / skill（`skill:<名字>`）。 */
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
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

/** `GET /api/agents`：磁盘上的子代理定义（内置 / 包 / 用户 / 项目）。 */
export interface WebAgentInfo {
  name: string;
  description: string;
  source: 'builtin' | 'package' | 'user' | 'project';
  /** 包里带过来的 agent 标上包名（界面上区分 pi-subagents 与其他包）。 */
  packageName?: string | undefined;
  filePath: string;
  tools: string[];
  model: string | null;
  thinking: string | null;
  enabled: boolean;
}

/** `GET /api/plugins` 里的一条：真的装上来的扩展。 */
export interface WebPluginInfo {
  name: string;
  version: string | null;
  description: string | null;
  /** `npm:<pkg>` / `git:<url>` / `local` / `path`。 */
  source: string;
  /** 扩展入口文件。 */
  path: string;
  baseDir: string | null;
  hidden: boolean;
}

/** `GET /api/plugins`。 */
export interface WebPluginsInfo {
  /** `settings.json` 的 `packages` 原样（可能带版本）。 */
  packages: string[];
  extensions: WebPluginInfo[];
  /** 装载诊断（包找不到、扩展加载失败…）。 */
  errors: string[];
}

/** `GET /api/mcp` 里的一条：`mcp.json` 里的服务器（只读配置，不连接）。 */
export interface WebMcpServerInfo {
  name: string;
  scope: 'global' | 'project';
  /** 定义它的文件。 */
  source: string;
  enabled: boolean;
  exposure: string;
  description: string | null;
  /** `stdio: cmd args` / `http: url`。 */
  transport: string;
  /** stdio 的环境变量名（**不传值** —— 里面有凭据）。 */
  envKeys: string[];
  /** HTTP 的请求头名（同样不传值）。 */
  headerKeys: string[];
}

/** `GET /api/mcp`。 */
export interface WebMcpInfo {
  servers: WebMcpServerInfo[];
  errors: string[];
  globalPath: string;
  projectPath: string;
  projectExists: boolean;
  autoEnableCodemode: boolean | null;
}

/** `POST /api/*` 的回执。 */
export interface WebActionResult {
  ok: boolean;
  message?: string | undefined;
}

/** `GET /api/system-prompt`：模型**实际收到**的那段系统提示词（顶栏「系统」用）。 */
export interface WebSystemPromptInfo {
  /** 渲染好的整段 —— 进请求的就是它。空串 = 工具被禁用那种空 prompt。 */
  text: string;
  /**
   * 分段（段名 → 渲染后的文本）。
   *
   * 老轨迹的 `prompt.init` 里没有这个字段，所以可能是空对象 —— 界面不能拿它当
   * 「有没有 prompt」的判据（判据是 `text`）。
   */
  sections: Record<string, string>;
}

/**
 * `GET /api/tools` 里的一条：模型看到的工具定义（顶栏「工具」用）。
 *
 * 与 `state.prompt.tools`（`PromptToolDefinition`）**同一份** —— 这里是线协议上的投影，
 * 字段逐字一致、不加工：`description` 若被 `prepareLoadout` 重写过，那段就是模型
 * 真正读到的（重写过的描述才是真话）。
 */
export interface WebToolDefinitionInfo {
  name: string;
  description: string;
  /** JSON Schema（typebox 序列化的结果），原样给界面自己解析。 */
  parameters: unknown;
}

/**
 * `GET /api/history` 里的一行。
 *
 * 消息原样给（渲染是前端/服务端页面的事），配置变更降级成一条注记 —— 界面只要
 * 「读得下去的时间线」，不需要知道轨迹里的 entry 形状。
 */
export type WebHistoryLine =
  | { kind: 'message'; at: string; message: Message }
  | { kind: 'note'; at: string; text: string };

/**
 * `GET /api/history[?sessionId=<id>]`：**完整历史**（顶栏那个按钮打开的那一页）。
 *
 * 不带 `sessionId` = 当前会话（内核 `state.session.id`）。带上它就能开**任意**一个会话：
 * 按 id 跨 `sessions/` 下每个目录找文件，于是不必先知道它当初在哪个 cwd 里
 * （`config-home` 的 `findSessionFileById()`）。找不到时 `missing: true`，服务端回 404。
 *
 * ## 为什么读会话文件而不是内存里的 `messages`
 *
 * 内存里的那份是**压缩之后**的当前上下文：被 `/compact` 掉的早期消息在那里根本不存在，
 * 而那一段正是「完整历史」要给人看的东西。所以首选会话文件；文件还没落盘（新会话
 * 一句话都没说过）时才退回内存那份。
 */
export interface WebHistoryInfo {
  sessionId: string;
  cwd: string;
  /** 会话文件路径；`null` = 还没落盘，内容来自内存。 */
  file: string | null;
  /**
   * `true` = 指定了 `?sessionId=` 但盘上没有那个会话（文件被删了 / 不在这台机器上）。
   *
   * 与「还没落盘」不是一回事：后者是**当前**会话还没写过文件，内容来自内存；
   * 这个是我们连它是谁都不知道。所以那一页要说得不一样（服务端回 404）。
   */
  missing?: boolean | undefined;
  lines: WebHistoryLine[];
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
      if (typeof text !== 'string') return undefined;
      const attachments = parseClientAttachments((value as { attachments?: unknown }).attachments);
      return {
        type: 'prompt',
        text,
        ...(attachments === undefined ? {} : { attachments }),
      };
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
    case 'resumeSession': {
      const id = (value as { id?: unknown }).id;
      const cwd = (value as { cwd?: unknown }).cwd;
      return typeof id === 'string' && id !== '' && typeof cwd === 'string'
        ? { type: 'resumeSession', id, ...(cwd === '' ? { cwd: '' } : { cwd }) }
        : undefined;
    }
    case 'ui-response': {
      const id = (value as { id?: unknown }).id;
      if (typeof id !== 'string') return undefined;
      const answer = (value as { value?: unknown }).value;
      const cancelled = (value as { cancelled?: unknown }).cancelled;
      return {
        type: 'ui-response',
        id,
        ...(typeof answer === 'string' ? { value: answer } : {}),
        ...(cancelled === true ? { cancelled: true } : {}),
      };
    }
    case 'ui-questionnaire-intent': {
      const id = (value as { id?: unknown }).id;
      if (typeof id !== 'string') return undefined;
      const intent = parseQuestionnaireIntent((value as { intent?: unknown }).intent);
      return intent === undefined ? undefined : { type: 'ui-questionnaire-intent', id, intent };
    }
    default:
      return undefined;
  }
}

/**
 * `prompt` 里附件的校形（**不认识的一律丢掉**，与其余客户端消息同一条规矩）。
 *
 * 服务端还会再验一遍能不能真的带给模型（`web/bridge.ts` 的
 * `usablePromptAttachments()`）：这里只保证形状是 `WebAttachment`，不替它判业务。
 * 少这一层的话字段会在 `parseClientMessage()` 这一步就消失 —— 症状是浏览器明明发了
 * `attachments`、内核收到的却只有一句文字（e2e 真踩过）。
 */
function parseClientAttachments(raw: unknown): WebAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const attachments: WebAttachment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const type = record['type'];
    const fileName = record['fileName'];
    const mimeType = record['mimeType'];
    if (type !== 'image' && type !== 'document') continue;
    if (typeof fileName !== 'string' || fileName === '') continue;
    if (typeof mimeType !== 'string' || mimeType === '') continue;
    const extractedText = record['extractedText'];
    const size = record['size'];
    attachments.push({
      id: typeof record['id'] === 'string' ? record['id'] : '',
      type,
      fileName,
      mimeType,
      size: typeof size === 'number' && Number.isFinite(size) ? size : 0,
      content: typeof record['content'] === 'string' ? record['content'] : '',
      ...(typeof extractedText === 'string' ? { extractedText } : {}),
    });
  }
  return attachments.length === 0 ? undefined : attachments;
}

/**
 * 问卷意图的校形。
 *
 * 不信任客户端（浏览器可能拿着旧帧、旧代码）：不认识的 `kind`、越界的序号、
 * 非字符串的文本一律丢掉 —— 进状态机之后它们会变成一份没人认识的状态。
 * 序号是否越界由状态机再判一次（它才知道题有儿个）。
 */
function parseQuestionnaireIntent(raw: unknown): QuestionnaireIntent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as { kind?: unknown; index?: unknown; text?: unknown };
  switch (value.kind) {
    case 'activate':
    case 'pick':
    case 'toggle':
      return typeof value.index === 'number' && Number.isInteger(value.index) && value.index >= 0
        ? { kind: value.kind, index: value.index }
        : undefined;
    case 'custom':
      return typeof value.index === 'number' &&
        Number.isInteger(value.index) &&
        value.index >= 0 &&
        typeof value.text === 'string'
        ? { kind: 'custom', index: value.index, text: value.text }
        : undefined;
    case 'note':
      return typeof value.index === 'number' &&
        Number.isInteger(value.index) &&
        value.index >= 0 &&
        typeof value.text === 'string'
        ? { kind: 'note', index: value.index, text: value.text }
        : undefined;
    case 'globalNote':
      return typeof value.text === 'string' ? { kind: 'globalNote', text: value.text } : undefined;
    case 'commit':
      return { kind: 'commit' };
    case 'submit':
      return { kind: 'submit' };
    case 'cancel':
      return { kind: 'cancel' };
    default:
      return undefined;
  }
}
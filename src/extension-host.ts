/**
 * pi 扩展宿主 —— 让**别人写的** pi 扩展能在本项目的环里跑起来。
 *
 * ## 为什么不自己重写扩展提供的那部分功能
 *
 * 第一个接的是 `@juicesharp/rpiv-ask-user-question`（见 `docs/architecture/extensions.md`）：
 * 它给模型一个 `ask_user_question` 工具 —— 一个结构化的多选对话框，带多问题 tab、
 * 单题/多选、notes、`preview` 侧栏、`Ctrl+]` 折叠、ESC 放弃。那套交互两千多行，
 * 而且带着一堆踩过才写出来的处理（jiti 缓存中毒后无法在进程内恢复、overlay 折叠后
 * 必须有 raw input 才能复原、notes 草稿被 submit 键静默吞掉…）。
 *
 * 重写一遍等于把它重做一次，而且会漂移。所以走 pi 官方的扩展运行时：
 * `loadExtensions()` 装载 + `ExtensionRunner` 驱动。扩展要什么
 * （`registerTool` / `ui.custom` / `before_agent_start` / `getActiveTools`）都由官方代码
 * 处理，本项目只提供**自己那一半**：环、store、工具执行、overlay 宿主。
 *
 * ## 复用了官方的哪几样
 *
 * | 官方件 | 干什么 |
 * | --- | --- |
 * | `DefaultPackageManager.resolve()` | `settings.json` 的 `packages` → 扩展入口路径（含去重、信任判断） |
 * | `loadExtensions()` | jiti 装载（**必需**：扩展的 `typebox`/`pi-tui`/`pi-coding-agent` 是 pi 注入的虚拟模块） |
 * | `ExtensionRunner` | 事件分发、上下文创建、工具上下文 |
 * | `wrapRegisteredTool` 那层形状 | 工具的 `parameters` / `execute` 契约 |
 *
 * ## 我们必须自己给的三样
 *
 * | 扩展要什么 | 本项目给什么 |
 * | --- | --- |
 * | `ctx.ui.custom()` | pi-tui 的 `showOverlay()`（`src/tui/overlay-host.ts`） |
 * | 工具执行 | 自己的 `getTool()` 注册表（`tools.ts`） |
 * | `setActiveTools()` | reducer 里的一条 action —— 状态只能由 action 改（见 `extension-tools.ts`） |
 *
 * ## 一处刻意的偏差
 *
 * 扩展的 prompt 注入在 pi 那边是**每轮现拼**，而工具集在本项目是**声明的**：
 * `state.prompt.tools` 是「现在能执行什么」，transcript 里的 system 消息是
 * 「模型被允许调什么」。会话中途可以变（`pi.setActiveTools()` 真的生效，
 * `web_enable` / `subagents_enable` 那些 loader 工具靠的就是它）—— 前提是**变了要声明**：
 * `reducer.ts` 的 `agent.run` 在请求前 diff 出 `toolsAdded` / `toolsRemoved`
 * 追加一条消息（pi-agent-core 的 `declareToolChanges` 同一步）。
 * 于是**已有消息一个字节不动**（prompt-cache 的前缀因此活下来），模型也明确知道工具变了。
 *
 * 由此推出一条**已知无效**的路径：`ask_user_question` 自带的 `before_agent_start`
 * 协调器（非交互时把工具摘掉）在本项目里是 no-op —— 工具集在会话中途不变，
 * 而本项目只有交互式一种模式（`hasUI` 恒为真）。这不是 bug，是上面那个决定的
 * 必然结果，测试里钉住了（`test/extension-host.test.ts`）。
 */
import {
  loadExtensions,
  createExtensionRuntime,
  loadExtensionFromFactory,
} from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import { createEventBus } from '@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent/dist/core/package-manager.js';
import { createSourceInfo } from '@earendil-works/pi-coding-agent/dist/core/source-info.js';
import type { PathMetadata } from '@earendil-works/pi-coding-agent/dist/core/package-manager.js';
import type { Extension } from '@earendil-works/pi-coding-agent/dist/core/extensions/types.js';
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { AgentStore } from './store';
import type { AgentTool, AgentToolResult } from './agent-tool';
import {
  callableTools,
  getCallableTool,
  registeredToolInfos,
  registerToolEntries,
  type RegisteredToolEntry,
  type ToolExposure,
  type ToolLoadout,
  type ToolLoadoutChanges,
  type ToolNamespace,
  activeToolNames,
} from './tools';
import {
  adaptExtensionTool,
  activeToolsFromState,
  applyActiveTools,
  type ExtensionToolDefinitionLike,
} from './extension-tools';
import { loadPiSettings } from './pi-config';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent/dist/core/extensions/types.js';
import { createHostUi, type ExtensionHostUi, type HostUiOptions } from './extension-ui';
import { extensionModelRegistry } from './extension-models';
import { extensionSessionManager } from './extension-sessions';
import { installExtensionCommands, type ExtensionCommands } from './extension-commands';
import { notifyBeforeAgentStart, type BeforeAgentStartHandler } from './extension-prompt';
import { configHome } from './config-home';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from './provider';
import type { PromptToolLike } from './system-prompt';
/**
 * 装好的**一个**扩展（显示用，最少字段）。
 *
 * ## 为什么要留路径与来源
 *
 * 开场那一节要报的是「装了哪些**扩展**」，而扩展的身份是它的入口文件 + 来自哪里
 * （npm 包 / git 仓库 / 本地路径）—— 与它注册了几个工具无关。
 *
 * 早先那一节报的是 `tools`（扩展注册的工具名），于是界面上写着 `[扩展] ask_user_question`，
 * 看起来像「装了一个叫 ask_user_question 的扩展」。那既不是扩展的名字，也不是 pi 的口径：
 * pi 的开场报的是入口（`pi-web-access:dist`），工具清单在别处（`/` 的工具列表）。
 * 那个字段仍要留着（诊断里会用到），但**不用于那一节**。
 */
export interface ExtensionEntry {
  /** 扩展入口文件（绝对路径）。 */
  path: string;
  /** 来源：`npm:<pkg>` / `git:<url>` / `local` / `cli` / `path`。 */
  source: string;
  /** 包根目录（npm/git 来源有），用来把路径缩成包内相对路径。 */
  baseDir?: string | undefined;
  /** 官方标记为隐藏的扩展不进开场清单（与 pi 一致）。 */
  hidden: boolean;
}

/** 装好的扩展宿主。 */
export interface ExtensionHost {
  /** 扩展提供的工具（已过 `extension-tools.ts` 那层适配，可直接进注册表）。 */
  readonly tools: readonly AgentTool[];
  /**
   * 扩展提供的 prompt 片段（`promptSnippet` / `promptGuidelines`）。
   *
   * 与官方工具走**同一个** `PromptToolLike` 形状，于是扩展工具在 prompt 里与
   * `read`/`bash` 没有区别：同一条 `<tools>` 段，同一条筛选规则（没有 snippet
   * 就不列 —— 那是官方语义：「不告诉模型它存在」）。
   */
  readonly promptTools: readonly PromptToolLike[];
  /**
   * 扩展的斜杠命令与快捷键。
   *
   * 界面用它在**自己的命令表之后**兜底：`runCommand` 找不到自己的命令时问它。
   * 不并进 `SLASH_COMMANDS`（那是常量的唯一真相），理由见 `extension-commands.ts`。
   */
  readonly commands: ExtensionCommands;
  /** 装载诊断（扩展加载失败、注册了但形状不对…）。 */
  readonly errors: readonly string[];
  /**
   * 装上了哪些**扩展**（入口 + 来源）—— 开场清单报的是它，不是工具名（见 `ExtensionEntry`）。
   */
  readonly entries: readonly ExtensionEntry[];
  /** 有没有任何扩展真的装上了。 */
  readonly loaded: number;
  /**
   * 每轮开始前给扩展一个 `before_agent_start`。
   *
   * 扩展可以改工具集（走 `setActiveTools` → reducer action）与**改 prompt 段**：
   * handler 在 `systemPromptOptions.sections` 里写回的段与「当前生效」那份一 diff，
   * 变了的段作为一条 `prompt.segment.added` 追加（按段名 patch，**已有消息不动**）。
   * 但**整段替换**（`systemPrompt` / `forceSystemPrompt`）仍然不采信：本项目的
   * system prompt 是装载时定下的，中途整段替换会让已发出的消息与 prompt 对不上。
   *
   * `ctx` 与事件里的 `selectedTools` 都是**真的**（官方 ctx + 当前声明给模型的工具名）
   * —— 扩展会读它们，给个最小版就是每轮一条 `Cannot read properties of undefined`
   * （见 `extension-prompt.ts` 的文件头）。
   */
  beforeAgentStart(text?: string | undefined): Promise<void>;
  /**
   * 发 `session_start`（内核在装载 prompt **之前**调一次）。
   *
   * MCP 扩展靠它读 `mcp.json` 并开始连接服务器：工具是在连接过程中**动态注册**
   * 进来的（`pi.registerTool` → 我们的 `refreshTools`），所以这个顺序不能反。
   * 同样靠它，MCP 会在发现有 codemode 暴露的服务器时激活 `codemode` ——
   * 那必须发生在 `prompt.init` 之前，否则模型看不到 codemode。
   */
  startSession(): Promise<void>;
  /**
   * 收集 `before_agent_start` 写进 `systemPromptOptions.sections` 的 prompt 段。
   *
   * MCP 就是靠这个把 `mcp_servers` 段（「有哪些服务器、工具怎么调」）塞进 prompt 的；
   * 那段是它自己那个 handler 算的（服务器列表在扩展闭包里，外面拿不到）。
   * 另外它还会用 `direct` 服务器最长 10 秒的等待 —— 所以**这一步必须在算声明工具之前调**。
   */
  collectPromptSections(): Promise<Record<string, string>>;
  /**
   * 工具执行前的 `tool_call` 事件（环在跑工具前调）。
   *
   * 两个用途：
   * - **MCP**：codemode 脚本点名了一个还没连上的服务器时，在这里等它（官方行为）；
   * - **权限类扩展**：可以 `block` 掉一次调用。
   * `block` 为 true 时环不执行那个工具（把 `reason` 当错误结果发回模型）。
   */
  beforeToolCall(
    toolCallId: string,
    name: string,
    input: Record<string, unknown>,
    options?: { parentToolCallId?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<{ block?: boolean; reason?: string | undefined; input: Record<string, unknown> }>;
  dispose(): void;
}

export interface LoadExtensionHostOptions {
  store: AgentStore;
  cwd: string;
  /**
   * 当前这套 provider/runtime。
   *
   * 扩展要自己调模型时（`pi-web-access` 的答案与摘要）靠它拿 `ctx.model` 与
   * `ctx.modelRegistry` 的凭证。不给 = 降级路径（`provider.ts` 退回了手写装配），
   * 于是 `ctx.modelRegistry` 是 `undefined`，扩展会用时才炸 —— 那是对的：那告诉
   * 用户「这条路上没接」，好过回一句「No API key available」而真因是**降级了**。
   */
  runtime?: AgentRuntime | undefined;
  /**
   * 造 `ctx.ui` 的**工厂**（不是实例）。
   *
   * 为什么是工厂：UI 依赖活着的 pi-tui 实例（浮层、raw input、焦点），那是界面层的
   * 东西，而内核不知道界面的存在。
   *
   * ## 不给 = 「真的没有界面」
   *
   * 此时**不调** `setUIContext`，于是官方的 `hasUI` 读出 false，扩展自己的
   * `if (!ctx.hasUI) return rejectWithoutUi()` 会先把工具**从清单里摘掉**。
   *
   * 这比「给一个什么都不做的 UI」重要得多：那个空 UI 里 `tui` 是 undefined，扩展
   * 一旦调 `ctx.ui.custom()` 就会在自己的渲染里炸
   * （`Cannot read properties of undefined (reading 'requestRender')` —— 实测过）。
   * 也就是说：**假装有界面比承认没有界面坏得多**。让扩展自己的 `hasUI` 判断说话。
   */
  uiOptions?: (() => HostUiOptions) | undefined;
  /** ���试注入：跳过整个装载流程。 */
  disabled?: boolean | undefined;
  /**
   * 要不要装 pi 的**内置扩展**（`codemode` 与 `mcp`）。默认 true。
   *
   * 关掉它的只有两类调用方：只测「用户装的扩展」的测试（`test/extension-host.test.ts`
   * 故意用真配置家目录，那里的 `mcp.json` 会让 MCP 真去连服务器），以及不想接 MCP 的嵌入方。
   * 内核**不关**（装了才有 MCP + codemode）。
   */
  builtins?: boolean | undefined;
  /**
   * 当前会话 id 的**取值函数**。
   *
   * 为什么是函数：它会变（`/new`、恢复历史）。扩展的 `getSessionId()` 问的时候得报
   * 当时的值，而注册时那个值还不是最终的。
   */
  sessionId?: (() => string) | undefined;
  /**
   * 当前会话**文件**路径的取值函数（同样是函数：`/new` 之后换文件）。
   *
   * `pi-subagents` 要它算「本会话的 subagent 产物放哪」（`session_start` 与每轮
   * `before_agent_start` 都读）；不给就是 `undefined`，它会回退到 sessionId。
   */
  sessionFile?: (() => string | undefined) | undefined;
  /**
   * `pi.sendMessage` 的落点：一条**用户消息**。
   *
   * 扩展用它把结论送回对话（`pi-web-access` 的命令全靠这个）。走用户消息而不是
   * 「直接改 messages」是因为它要**触发一轮**——那正是本项目环的入口（见 loop.md）。
   */
  onSendMessage?: ((text: string) => void) | undefined;
  /** 环是不是 idle。命令在环跑着时不能执行（否则中途插消息）。 */
  canSend?: (() => boolean) | undefined;
}

/** 空宿主：一个扩展都没有时的形状。 */
function emptyHost(errors: readonly string[] = []): ExtensionHost {
  return {
    tools: [],
    promptTools: [],
    commands: emptyCommands(),
    errors,
    entries: [],
    loaded: 0,
    beforeAgentStart: async () => {},
    startSession: async () => {},
    collectPromptSections: async () => ({}),
    beforeToolCall: async (_id, _name, input) => ({ input }),
    dispose: () => {},
  };
}

/** 一个扩展都没有时的空命令表（界面照样调，只是永远 nothing）。 */
function emptyCommands(): ExtensionCommands {
  return {
    list: () => [],
    has: () => false,
    run: async () => {
      throw new Error('没有装任何扩展');
    },
    handleKey: async () => false,
    // 没有扩展就没有扩展快捷键（`/hotkeys` 的 `Extensions` 一节也不出现）。
    shortcuts: () => [],
  };
}

/** 解析出来的入口 **加上它的包元数据**（官方 `ResolvedResource.metadata`）。 */
interface ResolvedExtensionEntry {
  path: string;
  metadata: PathMetadata;
}

/**
 * 读 `settings.json` 的 `packages`，解析成**扩展入口文件**的绝对路径 + 包元数据。
 *
 * ## 直接用官方的 `DefaultPackageManager`
 *
 * 它做的事比自己写一版多得多且都是必须的：用户级与项目级两份 settings 的合并、
 * 同一个包两处出现时项目优先（`autoload:false` 时是 delta 而非替换）、项目信任判断、
 * npm 包的安装目录解析（全局 npm root 还是 pi 自己那个 `npm/` 目录，取决于 pi 版本）。
 *
 * 自己读 `settings.json` 再拼路径，最后必然是「pi 装到哪儿我们不知道」——
 * 症状是 `pi list` 明明有，这边说没装。**取不到就当没装**（`onMissing: skip`），
 * 不自动 `npm install`：本项目不是包管理器，替 pi 装东西会让两边状态分家。
 *
 * ## 为什么连 `metadata` 一起带回来
 *
 * `loadExtensions(paths)` **不带**包信息：它的 `createExtension()` 给每个扩展硬写
 * `source: 'local'`、`baseDir = dirname(入口文件)`。于是 npm 包里的 `dist/index.js`
 * 被当成一个本地文件，开场清单会报成 `index.js`（而不是 `pi-web-access:dist`）——
 * 而 `settings.json` 里明明写的是 `@juicesharp/pi-web-access`。用户照着那一行找
 * 找不到自己配的包。
 *
 * 官方的 `DefaultResourceLoader` 有一步 `applyExtensionSourceInfo()` 专门补这个
 * （它把 metadata 写到 `extension.sourceInfo` 上）。我们不接那整个 ResourceLoader，
 * 所以自己补这一步 —— 用的还是它给的那份 metadata，不是自己猜的。
 */
async function resolveExtensionEntries(
  cwd: string,
  errors: string[],
): Promise<ResolvedExtensionEntry[]> {
  let settings: SettingsManager;
  try {
    settings = SettingsManager.create(cwd, configHome(), { projectTrusted: true });
  } catch (error) {
    errors.push(`扩展：读 settings 失败 —— ${msg(error)}`);
    return [];
  }
  let entries: ResolvedExtensionEntry[];
  try {
    const resolved = await new DefaultPackageManager({
      cwd,
      agentDir: configHome(),
      settingsManager: settings,
    }).resolve(async () => 'skip');
    entries = resolved.extensions
      .filter((r) => r.enabled)
      .map((r) => ({ path: r.path, metadata: r.metadata }));
  } catch (error) {
    errors.push(`扩展：解析包失败 —— ${msg(error)}`);
    return [];
  }
  return entries;
}

/**
 * 把包元数据写到每个扩展的 `sourceInfo` 上（官方 `applyExtensionSourceInfo` 的那一步）。
 *
 * ## 为什么连 command / tool 的 `sourceInfo` 一起改
 *
 * 官方那一步也顺带改了 `extension.commands` 与 `extension.tools` 里每一项的
 * `sourceInfo`。扩展自己读 `tool.sourceInfo.source` 来判断「我这个工具是不是
 * 被 `refreshTools` 重载过」（那种写法存在）—— 不改的话那些代码在 pi 那边是对的、
 * 在这边读到 `'local'`，于是行为分家。**跟官方同步**，不自己发明一小份。
 *
 * ## 逐级回退到祖先目录
 *
 * metadata 是按**包根**记的，而扩展入口是包里的某个文件（`dist/index.js`）。
 * 精确命中拿不到时就沿父目录往上找 —— 与官方 `findSourceInfoForPath()` 同一口径。
 */
function applyExtensionSourceInfo(
  extensions: readonly Extension[],
  entries: readonly ResolvedExtensionEntry[],
): void {
  const byPath = new Map(entries.map((e) => [e.path, e.metadata]));
  const findMetadata = (p: string): PathMetadata | undefined => {
    let current = p;
    for (;;) {
      const hit = byPath.get(current);
      if (hit !== undefined) return hit;
      const cut = Math.max(current.lastIndexOf('/'), current.lastIndexOf('\\'));
      if (cut <= 0) return undefined;
      current = current.slice(0, cut);
    }
  };
  for (const extension of extensions) {
    const metadata = findMetadata(extension.path);
    if (metadata === undefined) continue;
    extension.sourceInfo = createSourceInfo(extension.path, metadata);
    for (const command of extension.commands.values()) command.sourceInfo = extension.sourceInfo;
    for (const tool of extension.tools.values()) tool.sourceInfo = extension.sourceInfo;
  }
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 装扩展包。
 *
 * ## 失败不抛
 *
 * 扩展加载失败（版本不兼容、缺依赖、语法错）不该让应用起不来 —— 用户还是想聊天。
 * 收进 `errors` 交界面显示，与 skill 的 `skillDiagnostics` 同一口径：「静默退化」最该
 * 让人看见。
 */
export async function loadExtensionHost(
  options: LoadExtensionHostOptions,
): Promise<ExtensionHost> {
  const { store, cwd, uiOptions, disabled, runtime, sessionId, sessionFile, onSendMessage, canSend } =
    options;
  // runtime 没给时造一个「什么都没有」的占位，只为让 bindCore 的签名固定。
  // 它只会被读 `ctx.model`（→ undefined）与 modelRegistry（→ undefined），而
  // 那正是降级路径上该有的形状（见 extension-models.ts 的文件头）。
  const effectiveRuntime: AgentRuntime = runtime ?? {
    models: undefined as never,
    spec: { provider: '', model: '' } as never,
    model: undefined as never,
  };
  if (disabled === true) return emptyHost();

const errors: string[] = [];
  const onExtensionError = (where: string, message: string): void => {
    errors.push(`扩展 ${where}：${message}`);
  };
  const entries = await resolveExtensionEntries(cwd, errors);
  const withBuiltins = options.builtins !== false;
  // 一个都没有（也没内置）就不必建 runner 了 —— 与之前同一个早退。
  if (entries.length === 0 && !withBuiltins) return emptyHost(errors);

  const eventBus = createEventBus();
  // **共享一个 runtime**：内置扩展与文件扩展必须挂在同一个 runtime 上，否则
  // `pi.registerMcpServer()` 写进的注册表、runner 绑定的 refreshTools 会是两份。
  const runtimeHandle = createExtensionRuntime();
  const loaded = await loadExtensions(
    entries.map((e) => e.path),
    cwd,
    eventBus,
    runtimeHandle,
  );
  // `loadExtensions` 只知道「一个文件」，包信息在这一步补上（理由见
  // `resolveExtensionEntries` 与 `applyExtensionSourceInfo` 的注释）。
  applyExtensionSourceInfo(loaded.extensions, entries);
  for (const e of loaded.errors) errors.push(`扩展 ${shortPath(e.path)}：${e.error}`);

  // ── pi 的内置扩展（MCP + codemode）───
  //
  // 与 pi 的 CLI 同一个做法：`codemode` 与 `mcp` 都是**内置扩展**（`createCodemodeExtension()`
  // / `createMcpExtension()`），不是内核里的特殊代码。本项目不重写它们：MCP 客户端、
  // OAuth、工具命名、资源工具、`/mcp` 面板都是官方那几十个文件。
  //
  // **放在文件扩展之后**：本项目的工具收集是同名先注册者优先，而 pi 对
  // codemode / mcp 这两个是 `replaceable`（第三方同名扩展顶掉内置）—— 同样效果。
  //
  // `tool_search` 也装：它把 `codemode` / `deferred` 暴露的工具「装载」成声明
  // （BM25 搜一轮，命中的下一轮就进工具表）。早先不装的理由是「本项目的工具集装载时
  // 定死」，那条在工具集可变 + 声明链路就位之后不成立了 —— 它依赖的三样
  // （`getAllTools` 的 exposure/namespace、`getActiveTools`、真的生效的
  // `setActiveTools`）本项目都有，且它装载的结果会走 `tools.changed` → `agent.run`
  // 的声明增量，与前缀缓存那条约束不冲突。
  //
  // 它注册为 `defaultActive: false`（pi 也一样）：要用得在 `settings.json` 的
  // `defaultTools` 里写 `+tool_search`。
  if (withBuiltins) {
    const builtins: ReadonlyArray<{ factory: ExtensionFactory; path: string }> = [
      { factory: createMcpExtension(), path: 'builtin:mcp' },
      { factory: createCodemodeExtension(), path: 'builtin:codemode' },
      { factory: createToolSearchExtension(), path: 'builtin:tool-search' },
    ];
    for (const builtin of builtins) {
      try {
        loaded.extensions.push(
          await loadExtensionFromFactory(builtin.factory, cwd, eventBus, runtimeHandle, builtin.path),
        );
      } catch (error) {
        errors.push(`内置扩展 ${builtin.path}：${msg(error)}`);
      }
    }
  }
  if (loaded.extensions.length === 0) return emptyHost(errors);

  // runner 要 sessionManager 与 modelRegistry。本项目**不接** pi 的会话层（那是 pi 的
  // 应用层，见 surfaces.md），但 **modelRegistry 接** —— 扩展要自己调模型时只认它
  // （`pi-web-access` 的答案/摘要就靠它拿凭证）。
  //
  // sessionManager 仍传 `undefined as never`：扩展若去读它的成员（读会话条目以重建
  // 上下文），会在那里炸出「cannot read property of undefined」—— 那比给一个
  // **会静默说谎**的空实现好得多（后者会让扩展以为「会话里什么都没有」而改走另一条
  // 路，症状离真因很远）。
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    // **真的**会话：扩展要读条目（`pi-web-access` 的 `/search` 列历史搜索结果、
    // 判「模型这轮已经用过哪些 web 工具」）。数据源是**本项目的** `state.messages`，
    // 不是 pi 的 SessionManager —— 那是另一份内存（读文件的话只能看到上一次进程的）。
    // 详见 `extension-sessions.ts` 的文件头。
    extensionSessionManager(
      store,
      sessionId ?? (() => store.getState().trace.sessionId),
      sessionFile ?? (() => undefined),
    ) as never,
    extensionModelRegistry(effectiveRuntime) as never,
  );

  // ── 工具：从 runner 的注册表扫（而不是只扫装载那一刻）───
  //
  // MCP 的工具是在**服务器连上之后**才 `pi.registerTool()` 进来的，所以扫描只能包成
  // 一个函数，由 `refreshTools` 再调：否则一个连得慢的服务器，它的工具就永远不在本
  // 项目的表里，症状是「脚本报未知工具，而 `/mcp` 里明明有」。
  const tools: AgentTool[] = [];
  const promptTools: PromptToolLike[] = [];
  const syncExtensionTools = (): void => {
    const seen = new Set<string>();
    const registrations: RegisteredToolEntry[] = [];
    const snaps: PromptToolLike[] = [];
    // 同名的先注册者优先（与官方 `getAllRegisteredTools` 一个口径）。
    for (const reg of runner.getAllRegisteredTools()) {
      // 官方 `RegisteredTool` 只有 `definition` / `sourceInfo`，名字在 `definition.name` 上；
      // `as unknown as` 是因为官方的 `ToolDefinition` 字段比我们这层适配用到的多（annotations
      // 的形状也不完全一致）—— 只看我们真的要读的那几个。
      const d = reg.definition as unknown as ExtensionToolDefinitionLike & {
        name: string;
        exposure?: ToolExposure;
        namespace?: ToolNamespace;
        annotations?: Record<string, unknown>;
        defaultActive?: boolean;
        prepareLoadout?: (loadout: ToolLoadout) => ToolLoadoutChanges | undefined;
      };
      const name = d.name;
      if (seen.has(name)) continue;
      seen.add(name);
      if (typeof d.execute !== 'function') {
        errors.push(`扩展 ${shortPath(reg.sourceInfo?.path ?? name)}：工具 ${name} 没有 execute`);
        continue;
      }
      registrations.push({
        tool: adaptExtensionTool(name, d, { runner, store, cwd }),
        ...(d.exposure !== undefined ? { exposure: d.exposure } : {}),
        ...(d.namespace !== undefined ? { namespace: d.namespace } : {}),
        ...(d.annotations !== undefined ? { annotations: d.annotations } : {}),
        ...(d.defaultActive !== undefined ? { defaultActive: d.defaultActive } : {}),
        ...(d.promptSnippet !== undefined ? { promptSnippet: d.promptSnippet } : {}),
        ...(d.promptGuidelines !== undefined ? { promptGuidelines: d.promptGuidelines } : {}),
        ...(d.prepareLoadout !== undefined ? { prepareLoadout: d.prepareLoadout } : {}),
        ...(reg.sourceInfo !== undefined ? { sourceInfo: reg.sourceInfo } : {}),
      });
      // prompt 片段：官方语义是「**有 snippet 才进 prompt 的工具清单**」。
      //
      // 没有 snippet **不是错误** —— 工具照样在注册表里、照样进 API 请求的 tools 数组，
      // 模型看得到它的 `description`，只是不在 system prompt 的「工具怎么用」那一节
      // 被单独点名。pi 自己就是这个处理（它只把有 snippet 的收进 `_toolPromptSnippets`，
      // 没有 snippet 的不吭声）。
      //
      // 早先这里报一条诊断，理由是「没 snippet = 不告诉模型它存在」—— 那句对项目自己的
      // 四个工具成立（它们的用法全在 snippet 里），但对扩展不成立。实际的预警是
      // `pi-subagents` 0.77 的 `bg_wait`：它只有 `description`，而且**故意**不宣传
      // （它是 subagent 那条流里的补位工具，用法写在 `subagent` 的 snippet 里）。
      // 报出来就变成启动横幅上一句永远修不掉的 “[Extension issues]”，那就不是预警、
      // 是噪音了 —— 而噪音会让人把**真的**诊断一起忽略掉。
      if (d.promptSnippet !== undefined && d.promptSnippet !== '') {
        snaps.push({
          name,
          promptSnippet: d.promptSnippet,
          ...(d.promptGuidelines !== undefined && d.promptGuidelines.length > 0
            ? { promptGuidelines: [...d.promptGuidelines] }
            : {}),
        });
      }
    }
    registerToolEntries(registrations);
    tools.length = 0;
    tools.push(...registrations.map((r) => r.tool));
    promptTools.length = 0;
    promptTools.push(...snaps);
  };

  // 先绑 core（它把 `runtime.refreshTools` 接上），再扫一次。
  bindCore({
    runner,
    store,
    uiOptions,
    runtime: effectiveRuntime,
    onSendMessage,
    cwd,
    onError: onExtensionError,
    syncTools: syncExtensionTools,
  });
  syncExtensionTools();

  // `before_agent_start` 的 handler 按注册顺序抄一份（官方 emitBeforeAgentStart 会
  // 重建 system prompt，本项目没那份可重拼的 options，所以自己调 —— 理由见
  // `extension-prompt.ts` 文件头）。
  const beforeAgentStart: BeforeAgentStartHandler[] = [];
  for (const ext of loaded.extensions) {
    for (const h of ext.handlers.get('before_agent_start') ?? []) {
      beforeAgentStart.push(h as BeforeAgentStartHandler);
    }
  }

  // 斜杠命令与快捷键。handler 抛错收成诊断（与官方 `runner.onError` 同一口径）——
  // 扩展坏了不该把用户的对话带崩。
  const commands = installExtensionCommands({
    runner,
    store,
    onError: onExtensionError,
    ...(onSendMessage ? { onMessage: onSendMessage } : { onMessage: () => {} }),
    canSend: canSend ?? (() => store.getState().phase === 'idle'),
    shortcuts: loaded.extensions.flatMap((ext) =>
      [...ext.shortcuts.values()].map((s) => ({
        shortcut: s.shortcut,
        ...(s.description !== undefined ? { description: s.description } : {}),
        handler: s.handler as (ctx: unknown) => unknown,
      })),
    ),
  });

  return {
    tools,
    promptTools,
    commands,
    errors,
    // **只报用户装的扩展**（内置的 mcp / codemode 不算「你装了扩展」），与 pi 的开场口径一致。
    entries: loaded.extensions
      .filter((ext) => !ext.path.startsWith('builtin:'))
      .map((ext) => ({
        path: ext.path,
        source: ext.sourceInfo?.source ?? 'local',
        ...(ext.sourceInfo?.baseDir !== undefined ? { baseDir: ext.sourceInfo.baseDir } : {}),
        hidden: ext.hidden === true,
      })),
    loaded: loaded.extensions.length,
    beforeAgentStart: async (text?: string) => {
      const patch = await notifyBeforeAgentStart({
        handlers: beforeAgentStart,
        store,
        text,
        cwd,
        // **官方那个** ctx（与 `session_start` / `tool_call` 发出去的是同一个）——
        // 扩展会读 `ctx.sessionManager` / `ctx.hasUI`…，手搓一个最小 ctx 只会让它们
        // 在缺字段上炸（见 extension-prompt.ts 的文件头）。
        ctx: runner.createContext(),
        // 与扩展自己调 `pi.getActiveTools()` 同一个函数 —— 事件里那份工具名与它们从
        // 宿主问到的那份永远一致（见 `activeToolsFromState`）。
        selectedTools: activeToolsFromState(store.getState(), cwd),
        onError: onExtensionError,
      });
      // 扩展真改了 prompt 段：追加一条**补丁消息**（按段替换），而不是去改装载时那条
      // head —— 前缀缓存靠的就是「已有消息一个字节不动」（见 `prompt-head.ts`）。
      if (patch !== undefined) {
        store.dispatch({
          type: 'prompt.segment.added',
          role: 'system',
          // 文本为空：内容全在段里（`sections` 只带变了的段，`null` = 删段）。
          text: '',
          sections: patch,
          source: 'before_agent_start',
        });
      }
    },
    startSession: async () => {
      // 官方 `session_start`：MCP 靠它读 mcp.json 并开始连接服务器。
      await runner.emit({ type: 'session_start', reason: 'startup' });
    },
    collectPromptSections: async () => {
      // MCP 把自己的 `mcp_servers` 段写进 `event.systemPromptOptions.sections`；
      // 那个 handler 还会等 `direct` 服务器最多 10 秒。两个效果都是我们要的。
      const sections: Record<string, string> = {};
      const event = {
        type: 'before_agent_start' as const,
        prompt: '',
        images: [],
        // 这一刻 `prompt.init` 还没发生，所以 `activeToolsFromState` 读的是注册表的
        // 激活集 —— 正是扩展此刻从 `pi.getActiveTools()` 会读到的同一份。
        systemPromptOptions: {
          cwd,
          sections,
          selectedTools: activeToolsFromState(store.getState(), cwd),
        },
      };
      const ctx = runner.createContext();
      for (const handler of beforeAgentStart) {
        try {
          await handler(event as never, ctx as never);
        } catch (error) {
          onExtensionError('before_agent_start', msg(error));
        }
      }
      return sections;
    },
    beforeToolCall: (toolCallId, name, input, callOptions) =>
      emitToolCallGate(runner, onExtensionError, toolCallId, name, input, callOptions?.parentToolCallId),
    dispose: () => {
      // 先把 `session_shutdown` 发出去（MCP 关服务器），再作废 runner —— 反过来
      // handler 里的 ctx 就是 stale 的了。
      void (async () => {
        try {
          await runner.emit({ type: 'session_shutdown', reason: 'quit' });
        } catch {
          // 关不干净不该让退出卡住。
        } finally {
          runner.invalidate();
        }
      })();
    },
  };
}
/** `bindCore` 的入参（比之前那串位置参数好读，而且新加的两个都是必需的）。 */
interface BindCoreOptions {
  runner: ExtensionRunner;
  store: AgentStore;
  uiOptions: (() => HostUiOptions) | undefined;
  runtime: AgentRuntime;
  onSendMessage: ((text: string) => void) | undefined;
  cwd: string;
  onError: (where: string, message: string) => void;
  /** 重扫 runner 的注册表（`refreshTools` 与装载后的第一次扫描都走它）。 */
  syncTools: () => void;
}

/**
 * 发一次 `tool_call` 事件（顶层调用与 codemode 的嵌套调用**都**走它）。
 *
 * 为什么嵌套调用也要发：官方契约里嵌套调用的 id 是 `<父 id>/<n>` 且带
 * `parentToolCallId`，MCP 的 `tool_call` handler 就是靠它「脚本点名了还没连上的服务器时
 * 等它」。不发的话，脚本第一句调 `tools.mcp__rea__xxx` 就会报未知工具 —— 而服务器
 * 其实几秒后就绪。
 *
 * 不炸环：handler 抛错收成诊断（与官方 `runner.onError` 同一口径）。
 */
async function emitToolCallGate(
  runner: ExtensionRunner,
  onError: (where: string, message: string) => void,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
  parentToolCallId?: string,
): Promise<{ block?: boolean; reason?: string | undefined; input: Record<string, unknown> }> {
  const event: {
    type: 'tool_call';
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    parentToolCallId?: string;
  } = {
    type: 'tool_call',
    toolCallId,
    toolName: name,
    input,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
  };
  try {
    const result = await runner.emitToolCall(event as never);
    // 官方的 `tool_call` 允许 handler **就地改** `event.input`（权限类扩展靠它改写参数）。
    const finalInput = (event.input ?? input) as Record<string, unknown>;
    if (result?.block === true) {
      return {
        block: true,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        input: finalInput,
      };
    }
    return { input: finalInput };
  } catch (error) {
    onError('tool_call', msg(error));
    return { input };
  }
}

/** 嵌套调用的编号：官方用 `<父 id>/<n>`，n 按父 id 各自累加。 */
const nestedCounters = new Map<string, number>();
function nextNestedId(callerId: string): string {
  // 只在长会话里防一手内存：每个 codemode 调用的 id 都不同，计数用一次就不再需要。
  if (nestedCounters.size > 1000) nestedCounters.clear();
  const next = (nestedCounters.get(callerId) ?? 0) + 1;
  nestedCounters.set(callerId, next);
  return `${callerId}/${next}`;
}

/**
 * 把官方 runtime 接到本项目的 store / overlay 上。
 *
 * `ExtensionActions` 里有二十几个成员，其中大半是 pi 应用层的能力（换模型、改设置、
 * 换会话、树导航…）。本项目**不实现**它们 —— 下面给的是「不做事」的形状，不是
 * 「假做事」的形状：
 *
 * - 有意义的接真的：`getActiveTools` / `setActiveTools` / `getAllTools` /
 *   `getSettings` / `refreshTools` / `sendUserMessage` / `isIdle` / `getSystemPrompt`，
 *   以及 `contextActions` 里的 `executeTool` / `getCallableTools`（codemode 的命脉）；
 * - 换了模型 / 换思考级别返回 rejected Promise 而不是 resolve 成 no-op：调用方
 *   （扩展）会看到失败并**告诉用户**，而静默成功会让模型名与实际不符却无人察觉。
 */
function bindCore(options: BindCoreOptions): void {
  const { runner, store, uiOptions, runtime, onSendMessage, cwd, onError, syncTools } = options;
  const noUi = (what: string) => Promise.reject(new Error(`本项目不支持扩展的「${what}」`));
  runner.bindCore(
    {
      /**
       * `pi.sendMessage` —— 扩展把结论送回对话。
       *
       * 官方那个签名收的是 `CustomMessage`（带 `customType` / `display` / `details`），
       * 而本项目**不存** custom 条目（那是 pi 会话层的能力）。所以取它的 `content`
       * 里那些 text 块拼成一条**用户消息**。
       *
       * 丢弃 `customType` 的后果要说清：扩展的 `/curator` 那些命令靠它在转录里留
       * 一个可点开的卡片，而本项目只会把它当**普通对话**。那是外观上的降级，**不是**
       * 丢功能（结论照样回到对话里）。
       */
      sendMessage: (message: unknown) => {
        const content = (message as { content?: unknown })?.content;
        const text = Array.isArray(content)
          ? content
              .map((c) =>
                typeof c === 'string'
                  ? c
                  : typeof (c as { text?: unknown })?.text === 'string'
                    ? (c as { text: string }).text
                    : '',
              )
              .join('\n')
          : '';
        onSendMessage?.(text);
      },
      sendUserMessage: (content: unknown) => {
        const text = typeof content === 'string' ? content : String((content as { text?: unknown })?.text ?? '');
        if (text.trim() === '') return;
        store.dispatch({ type: 'user.message', text } as never);
      },
      /**
       * `pi.appendEntry` —— 存一条**不发给模型**的会话条目。
       *
       * **不存**（这是刻意的）：那正是 pi 会话层的能力，而本项目的会话是另一套
       * （见 sessions.md）。给 no-op 而不是报错，于是扩展自己的
       * `if (results.length === 0)` 那条路会走 —— `/search` 于是回一句
       * 「No stored search results」，那是**诚实的降级**而不是崩溃。
       *
       * 代价：`/search` 看不到历史搜索结果。记在 extensions.md 的「不接」清单里。
       */
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => activeToolsFromState(store.getState(), cwd),
      // **真的有**，不是 `[]`。`pi-web-access` 的 `web_enable`（动态启用 web 工具的
      // loader 工具）就靠它判断「这些工具到底在不在」：`[]` 会让它以为一个都没有，
      // 于是回一句「Cannot enable unavailable tools: web_search, ...」——
      // 而那些工具明明就在注册表里。症状是「模型永远调不了 web_search」。
      getAllTools: () => allToolsInfo(cwd),
      // 真的 settings（`codemode.mode` / `inlineBudget` / `defaultTools` 都从这里读）。
      getSettings: () => loadPiSettings() as never,
      // **真的**改（会话中途也改）：更新激活集 + 把新声明 dispatch 进 state。
      // 之后模型怎么被告知是 `agent.run` 的事（diff 出 `toolsAdded` / `toolsRemoved`），
      // 见 `extension-tools.ts` 的 `applyActiveTools`。
      setActiveTools: (names: string[]) => applyActiveTools(store, names, cwd),
      // **真的**刷新：MCP 服务器连上后 `pi.registerTool()` 会走到这里，我们重扫 runner
      // 的注册表并更新本项目的工具表（新工具从脚本 / `getAllTools()` 立刻可见）。
      // 新注册的工具若是**默认激活**的，它也该进声明 —— 所以这里再算一次声明
      // （`applyActiveTools` 用的是「当前激活集」，新工具自然在里面）。
      refreshTools: () => {
        syncTools();
        applyActiveTools(store, [...activeToolNames(cwd)], cwd);
      },
      getCommands: () => [],
      setModel: () => noUi('换模型'),
      getThinkingLevel: () => store.getState().thinkingLevel,
      setThinkingLevel: () => noUi('换思考级别'),
    } as never,
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => store.getState().phase === 'idle',
      // 本项目不实现项目信任：读项目内的 `.pi/SYSTEM.md` 与无条件读同目录 `AGENTS.md`
      // 风险相同（后者本来就无条件生效），见 system-prompt.ts 文件头的说明。
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => store.getState().systemPrompt,
      /** 嵌套调用（codemode 脚本里的 `tools.<name>()`）能调哪些 —— 本项目的可调表。 */
      getCallableTools: () => callableTools(cwd),
      /**
       * `ctx.executeTool()`：codemode 脚本调另一个工具。
       *
       * 与顶层调用走**同一个门**（`tool_call` 事件）—— MCP 靠它等「脚本点名了但还没连上」
       * 的服务器。结果形状是官方的 `AgentToolCallOutcome`；**失败不抛**，回 `isError: true`
       * （那是 codemode 脚本能 `Promise.allSettled()` 兜住的前提）。
       */
      executeTool: async (
        callerId: string,
        name: string,
        args: unknown,
        execOptions: { signal?: AbortSignal | undefined } | undefined,
      ) => {
        const nestedId = nextNestedId(callerId);
        const gate = await emitToolCallGate(
          runner,
          onError,
          nestedId,
          name,
          (args ?? {}) as Record<string, unknown>,
          callerId,
        );
        const toolCall = { type: 'toolCall', id: nestedId, name, arguments: gate.input };
        if (gate.block === true) {
          return {
            toolCall,
            result: {
              content: [{ type: 'text', text: gate.reason ?? `工具 ${name} 被阻止执行` }],
              details: {},
            },
            isError: true,
          };
        }
        const tool = getCallableTool(name, cwd);
        if (!tool) {
          return {
            toolCall,
            result: { content: [{ type: 'text', text: `未知工具：${name}` }], details: {} },
            isError: true,
          };
        }
        try {
          const result = await tool.execute(nestedId, gate.input, execOptions?.signal, undefined);
          return {
            toolCall,
            result: { content: result.content, details: result.details },
            isError: false,
          };
        } catch (error) {
          return {
            toolCall,
            result: {
              content: [{ type: 'text', text: `工具 ${name} 执行失败：${msg(error)}` }],
              details: {},
            },
            isError: true,
          };
        }
      },
    } as never,
  );
  // UI 在**界面层**造（它要活着的 `tui` 实例，而内核不知道界面的存在）。
  //
  // 没给工厂 = 一次性模式（`-p`）或测试 → **不绑 UI**，官方 `hasUI` 就是 false，
  // 扩展会把交互式工具从清单里摘掉。理由见 `LoadExtensionHostOptions.uiOptions` ——
  // 给一个空 UI 会让扩展在 `custom()` 里撞上 undefined 的 tui，比没有界面更糟。
  if (uiOptions !== undefined) {
    // `as never`：官方的 `ExtensionUIContext` 有 26 个成员（`setWidget` / `setFooter` /
    // `setHeader` / RPC 弹窗……），本项目只实现 3 个。直接断言会把「缺 23 个」这件事
    // 藏起来 —— 而它已经写在本文件与 `extension-ui.ts` 的注释里了。
    runner.setUIContext(createHostUi(uiOptions) as never, 'tui');
  }
}

/**
 * 官方的 `getAllTools()` 该看到什么 —— **本项目的工具注册表**，带真的元数据。
 *
 * 早先这里只给 `exposure: 'direct'`（「本项目不接 codemode 那套动态暴露」）。接了 MCP
 * 之后它就**必须**是真的：
 *
 * - `exposure`：MCP 扩展自己在 `ensureDiscoveryActive()` 里读它判断「有没有 codemode 工具
 *   需要被激活」。恒给 `direct` 会让它以为一个 codemode 工具都没有 —— 于是 codemode 不会
 *   被激活，MCP 工具全部不可达（而警告说的是「neither is active」，指向错的地方）。
 * - `namespace` / `annotations`：codemode 按 namespace 分组、权限扩展读 annotations 决定
 *   要不要确认。丢了两者都会静默退化。
 * - `sourceInfo`：给一个合法形状（`{ source: 'local' }`）而不是 undefined —— 扩展会在
 *   `getAllTools().find(...)` 之后去读它，给 undefined 会炸在一个假字段上，
 *   而那个堆栈与真因隔了三层。
 */
function allToolsInfo(cwd: string): ToolInfo[] {
  return registeredToolInfos(cwd).map((info) => ({
    name: info.name,
    description: info.description,
    parameters: info.parameters as ToolInfo['parameters'],
    exposure: info.exposure as ToolInfo['exposure'],
    ...(info.namespace !== undefined
      ? { namespace: info.namespace as NonNullable<ToolInfo['namespace']> }
      : {}),
    ...(info.annotations !== undefined
      ? { annotations: info.annotations as NonNullable<ToolInfo['annotations']> }
      : {}),
    sourceInfo: info.sourceInfo as ToolInfo['sourceInfo'],
  }));
}

/** 目录的短一点显示（错误信息里全路径太长，没人读得下去）。 */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

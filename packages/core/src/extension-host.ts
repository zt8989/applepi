/**
 * pi 扩展宿主 —— 让**别人写的** pi 扩展能在本项目的环里跑起来。
 *
 * 不自己重写扩展那部分功能：第一个接的 `ask_user_question` 两千多行，带着一堆踩过才写出来的
 * 处理（jiti 缓存中毒后无法在进程内恢复、overlay 折叠后必须有 raw input 才能复原、notes 草稿被
 * submit 键静默吞掉…），重写一遍会漂移。所以走官方运行时：`loadExtensions()` 装载 +
 * `ExtensionRunner` 驱动，本项目只提供自己那一半 —— 环、store、工具执行、overlay 宿主。
 *
 * 复用的官方件：`DefaultPackageManager.resolve()`（包清单 → 入口路径）、`loadExtensions()`（jiti
 * 装载，**必需** —— 扩展的 `typebox` / `pi-tui` / `pi-coding-agent` 是 pi 注入的虚拟模块）、
 * `ExtensionRunner`（事件分发、上下文创建）、`wrapRegisteredTool` 那层形状。
 *
 * 必须自己给的三样：`ctx.ui.custom()`（pi-tui 的 `showOverlay`，见 `extension-ui.ts`）、工具执行
 * （`tools.ts` 的注册表）、`setActiveTools()`（reducer 里的一条 action）。
 *
 * 一处刻意的偏差：工具集在本项目是**声明的** —— `state.prompt.tools` 是「现在能执行什么」，
 * transcript 里的 system 消息是「模型被允许调什么」。会话中途可以变，前提是**变了要声明**：
 * `agent.run` 在请求前 diff 出 `toolsAdded` / `toolsRemoved` 追加一条消息，于是已有消息一个字节
 * 不动（前缀缓存活下来）。由此推出 `ask_user_question` 自带的 `before_agent_start` 协调器在本
 * 项目里是 no-op —— 本项目只有交互式一种模式，测试里钉住了。
 */
import {
  loadExtensions,
  createExtensionRuntime,
  loadExtensionFromFactory,
} from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import { createEventBus } from '@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent/dist/core/package-manager.js';
import { readPiManifest } from '@earendil-works/pi-coding-agent/dist/core/pi-manifest.js';
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
import { QuestionnaireHost } from './questionnaire';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { extensionModelRegistry } from './extension-models';
import { extensionSessionManager } from './extension-sessions';
import { installExtensionCommands, type ExtensionCommands } from './extension-commands';
import { notifyBeforeAgentStart, type BeforeAgentStartHandler } from './extension-prompt';
import { configHome, PI_CONFIG_DIR } from './config-home';
import { herdrSelfReportingActive } from './herdr';
import type { ExtensionLifecycleEvent } from './extension-events';
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
 * 那一节不能报 `tools`（扩展注册的工具名）：那样界面上写着 `[扩展] ask_user_question`，
 * 看起来像「装了一个叫 ask_user_question 的扩展」。pi 的开场报的是入口
 * （`pi-web-access:dist`），工具清单在别处。`tools` 仍留着（诊断用），但不用于那一节。
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
  /**
   * 发一个 pi 的 **agent 生命周期事件**（`agent_start` / `agent_end` / `message_end` / …）。
   *
   * 由内核显式发而不是让 runner 自己感知：pi 那边这些事件来自 AgentSession，而本项目的环是
   * redux-loop、没有 AgentSession。所以接线在内核 —— store 相位变化发相位级三条，effect 里的
   * LLM/工具调用发 `message_end` / `tool_execution_*`。
   *
   * 顺序 = 调用顺序（同步开始执行 handler），handler 报错只记诊断、不让环崩。
   *
   * **内核不直接叫它**：走 `recordLifecycle()` —— 先 dispatch `extension.lifecycle`（进轨迹、
   * 可回放），再调这里发给扩展。`tool_call` **不在这里**：它是有返回值的门（`beforeToolCall`）。
   */
  emitLifecycle(event: ExtensionLifecycleEvent): void;
  /**
   * 收掉宿主：发 `session_shutdown`（MCP 靠它关服务器），再作废 runner。
   *
   * **可等待**，这是必需的：MCP 的 stdio 服务器是子进程，会握着事件循环。一次性模式
   * （`-p`）跑完那一刻如果不等它们关掉，进程就退不出去（`process.on('exit')` 里做不了
   * 异步收尾 —— 那一刻已经在退了）。见 `main.ts` 退出路径上的说明。
   *
   * 给一个上限：某个服务器赖着不走时也不能把退出挂死（到点就作废 runner 返回）。
   */
  dispose(): Promise<void>;
}

/**
 * 生命周期事件的形状在 `extension-events.ts`（那里是唯一真相）—— 这里重导出一份，
 * 于是 `ExtensionHost` 的用家可以只从这一个模块拿到 `emitLifecycle` 与它的载荷类型。
 */
export type { ExtensionLifecycleEvent } from './extension-events';

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
   * 造 `ctx.ui` 的**工厂**（不是实例）：UI 依赖活着的 pi-tui 实例，而内核不知道界面的存在。
   *
   * 不给工厂 = 「真的没有界面」：此时**不调** `setUIContext`，官方 `hasUI` 读出 false，扩展自己
   * 的 `if (!ctx.hasUI)` 分支会先把工具摘掉。**假装有界面比承认没有界面坏得多** —— 空 UI 里
   * `tui` 是 undefined，扩展一调 `ctx.ui.custom()` 就在自己的渲染里炸
   * （`Cannot read properties of undefined (reading 'requestRender')`）。
   */
  uiOptions?: (() => HostUiOptions) | undefined;
  /** ���试注入：跳过整个装载流程。 */
  disabled?: boolean | undefined;
  /**
   * 要不要装 pi 的**内置扩展**（`codemode` 与 `mcp`）。默认 true。
   *
   * 关掉它的只有两类调用方：只测「用户装的扩展」的测试（`packages/core/test/extension-host.test.ts`
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
    emitLifecycle: () => {},
    dispose: async () => {},
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

/**
 * 解析出来的入口 **加上它的包元数据**（官方 `ResolvedResource.metadata`）。
 *
 * 本地目录里发现的扩展**没有**包元数据（`metadata: undefined`）—— 它们不是包，
 * 官方 loader 已经给它们写好了 `sourceInfo`（`source: 'local'` + 入口所在目录），
 * 不需要这里再补。
 */
interface ResolvedExtensionEntry {
  path: string;
  metadata?: PathMetadata | undefined;
}

/** 本地扩展目录里一个文件名像不像扩展入口（与 pi `isExtensionFile` 同一判据）。 */
function isExtensionFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js');
}

/**
 * 一个目录里的扩展入口（与 pi 的 `resolveExtensionEntries` 逐条对应）。
 *
 * 1. `package.json` 里 `pi.extensions` 声明的路径（存在几个算几个）；
 * 2. 否则 `index.ts`；
 * 3. 再否则 `index.js`；
 * 4. 都没有就是 `null`（这个子目录不是扩展）。
 */
function directoryExtensionEntries(dir: string): string[] | null {
  const manifestPath = path.join(dir, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = readPiManifest(manifestPath);
    if (manifest?.extensions !== undefined && manifest.extensions.length > 0) {
      const entries: string[] = [];
      for (const entry of manifest.extensions) {
        const resolved = path.resolve(dir, entry);
        if (existsSync(resolved)) entries.push(resolved);
      }
      if (entries.length > 0) return entries;
    }
  }
  const indexTs = path.join(dir, 'index.ts');
  if (existsSync(indexTs)) return [indexTs];
  const indexJs = path.join(dir, 'index.js');
  if (existsSync(indexJs)) return [indexJs];
  return null;
}

/**
 * herdr 托管的那份 **pi 扩展**（`~/.pi/agent/extensions/herdr-agent-state.ts`）？
 *
 * 为什么要跳过它：ela 自己上报 pane（`herdr.ts`）时，这份扩展会在同一个进程里也报一遍
 * （source `herdr:pi`），而 herdr 的官方 source 一旦持有 pane，自定义 source 就再也拿不到
 * `resume_argv`（实测：状态上报回 ok，但 pane 的 authority 仍旧是 `herdr:pi`）——
 * 结果服务器重启时 herdr 用内置的 `pi --session <id>` 拉起一个没有 ela 状态的 pi。
 * 全部理由见 [herdr.ts](./herdr.ts) 的文件头。
 *
 * 为什么按**文件内容**而不是文件名认：文件名是 herdr 写死的安装位置，但用户完全可以
 * 在别处放一个同名文件；而 herdr 在文件头留了机器可读的标记
 * （`// installed by herdr` + `// HERDR_INTEGRATION_ID=pi`），那才是稳定且不会误伤
 * 用户自写扩展的判据。读不到就当不是：宁可多装一个，也不要吃掉用户自己的东西。
 */
function isHerdrManagedPiIntegration(filePath: string): boolean {
  let head: string;
  try {
    // 标记就在文件头，读进来再截断：扩展文件都很小（十几 KiB），不值得为它上 openSync
    // + 定长 read 那一套。
    head = readFileSync(filePath, 'utf8').slice(0, 2048);
  } catch {
    return false;
  }
  return head.includes('installed by herdr') && head.includes('HERDR_INTEGRATION_ID=pi');
}

/**
 * 扫一个 `extensions/` 目录（与 pi 的 `discoverExtensionsInDir` 同一套规则）。
 *
 * - 只下探**一层**：`extensions/*.ts` / `*.js`，或 `extensions/<子目录>/`（按上面的
 *   入口规则取）；更深的嵌套要靠子目录自己的 `package.json` 声明。
 * - 不排序：返回 `readdirSync` 的顺序，与 pi 逐字一致 —— 顺序是语义（同名工具先到先得），
 *   自己排一遍就会在「pi 那边谁生效」与「ela 这边谁生效」之间造出差。
 */
function discoverExtensionsInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered: string[] = [];
  for (const entry of dirents) {
    const entryPath = path.join(dir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      discovered.push(entryPath);
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const entries = directoryExtensionEntries(entryPath);
      if (entries !== null) discovered.push(...entries);
    }
  }
  return discovered;
}

/**
 * 本项目内置的 `ask_user_question` 入口（`@juicesharp/rpiv-ask-user-question` 的
 * pinned 依赖 + `patches/*.patch`）。
 *
 * 为什么按路径而不是 `import`：它是给 pi 的 loader 写的源码（peer 依赖 `typebox` /
 * pi-tui / pi-coding-agent，其中 `typebox` 只由 loader 以**虚拟模块**注入）——
 * 直接静态 import 会在这里解析不到 `typebox`。
 *
 * 取不到（依赖没装、被 prune 掉）就给 `undefined` 并留一条诊断：那时候
 * `/resume` 那种"模型看不到这个工具"的降级比崩了好。
 */
function askUserQuestionEntryPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve('@juicesharp/rpiv-ask-user-question');
  } catch {
    return undefined;
  }
}

/** 某一个 resolved 扩展是不是那份 npm 装的 `ask_user_question`（要排掉的那个）。 */
function isAskUserQuestionSource(source: string): boolean {
  return source.includes('rpiv-ask-user-question');
}

/**
 * 把**本地扩展目录**与 `settings.json` 的 `packages` 合成一份扩展入口表。
 *
 * 顺序与 pi 一致（`discoverAndLoadExtensions()`）：`<cwd>/.pi/extensions/` →
 * `<agentDir>/extensions/` → `settings.json` 的 `packages`。顺序**是语义**：工具表是同名先注册
 * 者优先，「谁顶掉谁」只能由这份顺序决定。
 *
 * 本地目录必须扫：`pi` 的本地扩展（`~/.pi/agent/extensions/*.ts`）**不在** `settings.json` 里，
 * 是「放到那儿就生效」—— Orca 给 pi 装的托管扩展走的正是这条路，只读 `packages` 就永远装不上。
 *
 * 包那一半用官方的 `DefaultPackageManager`：两份 settings 的合并、同包两处的项目优先、
 * 项目信任判断、npm 安装目录解析，自己写必然落成「pi 装到哪儿我们不知道」。**取不到就当没装**，
 * 不自动 `npm install`（本项目不是包管理器）。
 *
 * 连包的 `metadata` 一起带回来：`loadExtensions()` 会给每个扩展硬写 `source: 'local'` 与
 * `baseDir = dirname(入口文件)`，于是 npm 包的 `dist/index.js` 在开场清单里报成 `index.js`，
 * 而用户配的是 `@juicesharp/pi-web-access` —— 照着那一行找不到自己配的包。本地目录里发现的
 * 扩展不需要这一步：它们**就是** `local`。
 */
async function resolveExtensionEntries(
  cwd: string,
  errors: string[],
): Promise<ResolvedExtensionEntry[]> {
  const resolvedCwd = path.resolve(cwd);
  // 本地扩展**先**入表（与 pi 同序）。没有包元数据 —— 它们是文件，不是包。
  //
  // 自己上报 herdr 时把 herdr 托管的那份 pi 扩展挡掉：否则它会抢走 pane 的 authority，
  // 让我们的 `resume_argv` 永远进不去（见 herdr.ts 的文件头）。`ELA_HERDR_AGENT=off`
  // 时这里不算「自己上报」，那份扩展照常装。
  const selfReportingHerdr = herdrSelfReportingActive();
  const local: ResolvedExtensionEntry[] = [
    ...discoverExtensionsInDir(path.join(resolvedCwd, PI_CONFIG_DIR, 'extensions')),
    ...discoverExtensionsInDir(path.join(configHome(), 'extensions')),
  ]
    .filter((p) => !(selfReportingHerdr && isHerdrManagedPiIntegration(p)))
    .map((p) => ({ path: p }));
  let settings: SettingsManager;
  try {
    settings = SettingsManager.create(cwd, configHome(), { projectTrusted: true });
  } catch (error) {
    errors.push(`扩展：读 settings 失败 —— ${msg(error)}`);
    return local;
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
      // 官方 `DefaultPackageManager.resolve()` 也扫 `<agentDir>/extensions`（不只是
      // `settings.json` 的 packages），所以 herdr 那份扩展会**在这里再出现一次**；
      // 上面那次过滤不够，同一条判据要在这里再用一遍（去重是按路径做的，两处都
      // 不剩才是真的不装）。
      .filter((r) => !(selfReportingHerdr && isHerdrManagedPiIntegration(r.path)))
      .map((r) => ({ path: r.path, metadata: r.metadata }));
  } catch (error) {
    errors.push(`扩展：解析包失败 —— ${msg(error)}`);
    return local;
  }
  // 去重按**入口绝对路径**（与 pi `addPaths` 的 `seen` 同一口径）：同一个文件既在本地
  // 目录里又被 `packages` 点名时只装一次（否则同一个工厂跑两遍，工具注册两遍）。
  const seen = new Set<string>();
  const merged: ResolvedExtensionEntry[] = [];
  for (const entry of [...local, ...entries]) {
    const key = path.resolve(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/**
 * 把包元数据写到每个扩展的 `sourceInfo` 上（官方 `applyExtensionSourceInfo` 的那一步）。
 *
 * 连 `commands` / `tools` 里每一项的 `sourceInfo` 一起改：扩展会用
 * `tool.sourceInfo.source` 判断「我这个工具是不是被 `refreshTools` 重载过」，不改的话那些代码
 * 在 pi 那边对、在这边读到 `'local'`，行为就分家。
 *
 * metadata 按**包根**记而扩展入口是包里的某个文件，精确命中拿不到时沿父目录往上找。
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
 * `dispose()` 等 `session_shutdown` 的上限。
 *
 * 一个服务器赖着不走（stdio 传输自己有 ~2.5s 的「关 stdin → SIGTERM → SIGKILL」兜底，
 * OAuth 的 token 落盘也可能慢一点）时，退出不该跟着一起挂死 —— 到点就作废 runner 返回，
 * 剩下的子进程交给传输自己的 `process.on('exit')` 钩子兜底。
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

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
  // `dispose()` 只该真跑一次（内核可能在退出路径与测试 `t.after()` 各调一次）。
  let hostDisposed = false;
  const onExtensionError = (where: string, message: string): void => {
    errors.push(`扩展 ${where}：${message}`);
  };
  const withBuiltins = options.builtins !== false;
  // 我们那份 `ask_user_question`（pinned 依赖 + `patches/*.patch`）。
  const askUserQuestion = askUserQuestionEntryPath();
  const entries = await resolveExtensionEntries(cwd, errors);
  // settings 里写 `npm:@juicesharp/rpiv-ask-user-question` 的那一条（pi 自己装到
  // `~/.pi/agent/npm` 的那份）换成**我们这个仓库里 patch 过的版本**：
  //
  // - 工具表是"同名先注册者优先"，两份都在的话生效的可能是**没补丁**的那份，
  //   而症状只是"浏览器那份问卷不出现"，看不出哪里不对；
  // - 包信息（metadata）留着，开场清单里报的还是那个包名，不是 `index.ts`。
  //
  // 我们的版本取不到时（依赖被 prune）保持原样：那种情况下问卷少一半（没有浏览器
  // 那份），但工具还能用 —— 比整个工具消失强。
  const resolvedEntries =
    askUserQuestion === undefined
      ? entries
      : entries.map((e) =>
          // 本地扩展没有包元数据，`e.metadata` 可能是 undefined，所以要 `?.`。
          e.metadata !== undefined && isAskUserQuestionSource(e.metadata.source)
            ? { ...e, path: askUserQuestion }
            : e,
        );
  // 一个都没有（也没内置）就不必建 runner 了 —— 与之前同一个早退。
  if (resolvedEntries.length === 0 && !withBuiltins) return emptyHost(errors);

  const eventBus = createEventBus();
  // **共享一个 runtime**：内置扩展与文件扩展必须挂在同一个 runtime 上，否则
  // `pi.registerMcpServer()` 写进的注册表、runner 绑定的 refreshTools 会是两份。
  const runtimeHandle = createExtensionRuntime();
  //
  // 官方的 `loadExtensions()` 内部是串行的（一个 import 完再下一个），而每个扩展的装载互不等待
  // —— 实测三个 npm 扩展串行 2.7s、并行 1.4s，而这段时间整个在首帧之前的关键路径上。
  //
  // 并行不改变语义：`eventBus` / `runtimeHandle` 仍共用同一个（事件在 `startSession()` 才统一
  // 发，与谁先注册无关）；结果**按原顺序**拼回去（工具表是同名先注册者优先，顺序漂了重名工具谁
  // 生效就变成随机）；一个扩展失败只收进 `errors`，与串行时的诊断一样。
  //
  // 扩展个数很少，不需要限流。
  const results = await Promise.all(
    resolvedEntries.map((entry) => loadExtensions([entry.path], cwd, eventBus, runtimeHandle)),
  );
  const loaded = {
    extensions: results.flatMap((result) => result.extensions),
    errors: results.flatMap((result) => result.errors),
    warnings: results.flatMap((result) => result.warnings),
    runtime: runtimeHandle,
  };
  // `loadExtensions` 只知道「一个文件」，包信息在这一步补上（理由见
  // `resolveExtensionEntries` 与 `applyExtensionSourceInfo` 的注释）。
  applyExtensionSourceInfo(loaded.extensions, resolvedEntries);
  for (const e of loaded.errors) errors.push(`扩展 ${shortPath(e.path)}：${e.error}`);

  //
  // 与 pi 的 CLI 同一个做法：`codemode` 与 `mcp` 都是**内置扩展**，本项目不重写它们（MCP 客户端、
  // OAuth、工具命名、资源工具、`/mcp` 面板都是官方那几十个文件）。放在文件扩展**之后**：同名先
  // 注册者优先，而 pi 对这两个是 `replaceable`（第三方同名扩展顶掉内置）。
  //
  // `tool_search` 也装：它把 `codemode` / `deferred` 暴露的工具「装载」成声明（BM25 搜一轮，
  // 命中的下一轮进工具表）。它依赖的三样（`getAllTools` 的 exposure/namespace、
  // `getActiveTools`、真的生效的 `setActiveTools`）本项目都有，装载结果也走 `tools.changed` →
  // `agent.run` 的声明增量，与前缀缓存那条约束不冲突。它注册为 `defaultActive: false`：
  // 要用得在 `defaultTools` 里写 `+tool_search`。
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
    // `ask_user_question` 也是内置的，但它**不是**一个 factory：它是
    // `@juicesharp/rpiv-ask-user-question`（本仓库的 pinned 依赖 + `patches/*.patch`），
    // 入口是包里的 `.ts` 文件，得走 loader 才拿得到它的虚拟依赖（`typebox` / pi-tui 是
    // pi 注入的，不在我们 node_modules 里）。所以按**路径**交给同一个 `loadExtensions`。
    //
    // settings 里列了它时上面那一步已经换过路径、装过了（这里就别装两遍）；没列也装上
    // —— 它不是一个可选能力，是模型用来问东西的那条路。
    if (askUserQuestion !== undefined && !resolvedEntries.some((e) => e.path === askUserQuestion)) {
      try {
        const built = await loadExtensions([askUserQuestion], cwd, eventBus, runtimeHandle);
        for (const e of built.errors) errors.push(`内置扩展 ask-user-question：${e.error}`);
        loaded.extensions.push(...built.extensions);
      } catch (error) {
        errors.push(`内置扩展 ask-user-question：${msg(error)}`);
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

  //
  // `createHostUi` 把它挂成 `ctx.ui.externalQuestionnaire`：扩展（patch 过的那份）
  // 在画自己的终端组件之前把题目交过来，我们开浏览器那份弹窗。两边谁先答都算数。
  //
  // 视图那半边（`HostUiOptions.questionnaire`）**惰性读**：界面起来之前那份 options 还没填
  // （与 `ctx.ui.custom()` 同一个道理）。
  const questionnaire = new QuestionnaireHost(() => uiOptions?.().questionnaire);

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
      // 没 snippet 不报诊断：那句「没 snippet = 不告诉模型它存在」只对项目自己的四个工具成立
      // （用法全在 snippet 里），对扩展不成立 —— `pi-subagents` 的 `bg_wait` 只有
      // `description` 且**故意**不宣传（用法写在 `subagent` 的 snippet 里）。报出来就是启动横幅
      // 上一句永远修不掉的 “[Extension issues]”，而噪音会让人把**真的**诊断一起忽略掉。
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

  // UI 在**界面层**造（它要活着的 `tui` 实例，而内核不知道界面的存在）。
  //
  // 没给工厂 = 一次性模式（`-p`）或测试 → **不绑 UI**，官方 `hasUI` 就是 false，
  // 扩展会把交互式工具从清单里摘掉。理由见 `LoadExtensionHostOptions.uiOptions` ——
  // 给一个空 UI 会让扩展在 `custom()` 里撞上 undefined 的 tui，比没有界面更糟。
  //
  // 存住这个实例：`ctx.hasUI` 是按 `uiContext` 的**引用**判的（官方的口径），
  // 每次新建一个会把那个判断搅乱。
  if (uiOptions !== undefined) {
    // `as never`：官方的 `ExtensionUIContext` 有 26 个成员（`setWidget` / `setFooter` /
    // `setHeader` / RPC 弹窗……），本项目只实现那几个真的能做的。直接断言会把
    // 「缺一堆」这件事藏起来 —— 而它已经写在本文件与 `extension-ui.ts` 的注释里了。
    runner.setUIContext(createHostUi(uiOptions, questionnaire) as never, 'tui');
  }

  // 先绑 core（它把 `runtime.refreshTools` 接上），再扫一次。
  bindCore({
    runner,
    store,
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
        // 官方的必填字段：`pi-background-tasks` 的 shell 策略 handler 先校验它，
        // 缺了就是启动时一条 `pi_bg_shell_prompt_unsupported`，且它那段 shell 指引
        // 永远进不了 prompt。这一刻 `prompt.init` 还没发生，所以是空串 ——
        // **形状**才是扩展要的（内容走 `sections`，见下面那个字段）。
        systemPrompt: store.getState().prompt.systemPrompt,
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
    // 生命周期事件：发出去就完事（不等 handler），但**同步开始**执行 —— 于是调用顺序就是
    // 扩展看到的顺序（status 钩子那些 handler 是同步的，`post()` 不 await 网络）。
    //
    // 报错只记诊断：一个状态扩展写坏了不该把整轮对话带崩（与 `beforeToolCall` 同一口径）。
    emitLifecycle: (event) => {
      try {
        void Promise.resolve(runner.emit(event as never)).catch((error: unknown) =>
          onExtensionError(event.type, msg(error)),
        );
      } catch (error) {
        onExtensionError(event.type, msg(error));
      }
    },
    dispose: async () => {
      if (hostDisposed) return;
      hostDisposed = true;
      // 先把 `session_shutdown` 发出去（MCP 关服务器），再作废 runner —— 反过来
      // handler 里的 ctx 就是 stale 的了。
      //
      // **要 await**：MCP 关的是 stdio 子进程，不等它们收掉，一次性模式的进程会一直
      // 挂在它们握着的事件循环上（见接口上的注释与 `main.ts` 的退出路径）。
      //
      // 但仍给上限：某个服务器赖着不走时不能让退出挂死。到点就作废 runner 返回 ——
      // 剩下的子进程由 stdio 传输自己的 `process.on('exit')` 钩子在进程真退出时兜底杀掉。
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          runner.emit({ type: 'session_shutdown', reason: 'quit' }).catch(() => {
            // 关不干净不该让退出卡住。
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        runner.invalidate();
      }
    },
  };
}
/** `bindCore` 的入参（比之前那串位置参数好读，而且新加的两个都是必需的）。 */
interface BindCoreOptions {
  runner: ExtensionRunner;
  store: AgentStore;
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
  const { runner, store, runtime, onSendMessage, cwd, onError, syncTools } = options;
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
}

/**
 * 官方的 `getAllTools()` 该看到什么 —— **本项目的工具注册表**，带真的元数据：
 *
 * - `exposure`：MCP 扩展在读它判断「有没有 codemode 工具需要被激活」。恒给 `direct` 会让它以为
 *   一个都没有 —— 于是 codemode 不被激活、MCP 工具全部不可达。
 * - `namespace` / `annotations`：codemode 按 namespace 分组、权限扩展读 annotations 决定要不要
 *   确认。丢了两者都会静默退化。
 * - `sourceInfo`：给合法形状（`{ source: 'local' }`）而不是 undefined —— 扩展会去读它。
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

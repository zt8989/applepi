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
 * 扩展的 prompt 注入（`promptSnippet` / `promptGuidelines`）在 pi 那边是**每轮现拼**，
 * 本项目的 system prompt 是**装载时定下**的（`prompt.init`，见 `system-prompt.ts`）。
 * 工具集不该在一轮对话中间变 —— 那会让已发出的 `messages` 与 prompt 对不上，而
 * prompt-cache 的前缀也整个作废。所以只在装载时装一次，改工具集要 `/new` 换会话，
 * 与 skill 清单同一个口径。
 *
 * 由此推出一条**已知无效**的路径：`ask_user_question` 自带的 `before_agent_start`
 * 协调器（非交互时把工具摘掉）在本项目里是 no-op —— 工具集在会话中途不变，
 * 而本项目只有交互式一种模式（`hasUI` 恒为真）。这不是 bug，是上面那个决定的
 * 必然结果，测试里钉住了（`test/extension-host.test.ts`）。
 */
import { loadExtensions } from '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent/dist/core/extensions/runner.js';
import { createEventBus } from '@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent/dist/core/package-manager.js';
import { createSourceInfo } from '@earendil-works/pi-coding-agent/dist/core/source-info.js';
import type { PathMetadata } from '@earendil-works/pi-coding-agent/dist/core/package-manager.js';
import type { Extension } from '@earendil-works/pi-coding-agent/dist/core/extensions/types.js';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentStore } from './store';
import type { AgentTool, AgentToolResult } from './agent-tool';
import { getTool, getTools, registerExtraTools } from './tools';
import { adaptExtensionTool, activeToolsFromState, applyActiveTools } from './extension-tools';
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
   * 扩展可以改工具集（走 `setActiveTools` → reducer action）与注入 prompt 片段。
   * prompt 片段**只记在诊断里、不采信**：本项目的 prompt 是装载时定下的，中途改会让
   * 已发出的消息与 prompt 对不上。改 prompt 要 `/new`。
   */
  beforeAgentStart(text?: string | undefined): Promise<void>;
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
   * 当前会话 id 的**取值函数**。
   *
   * 为什么是函数：它会变（`/new`、恢复历史）。扩展的 `getSessionId()` 问的时候得报
   * 当时的值，而注册时那个值还不是最终的。
   */
  sessionId?: (() => string) | undefined;
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
  const { store, cwd, uiOptions, disabled, runtime, sessionId, onSendMessage, canSend } = options;
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
  const entries = await resolveExtensionEntries(cwd, errors);
  if (entries.length === 0) return emptyHost(errors);

  const eventBus = createEventBus();
  const loaded = await loadExtensions(
    entries.map((e) => e.path),
    cwd,
    eventBus,
  );
  // `loadExtensions` 只知道「一个文件」，包信息在这一步补上（理由见
  // `resolveExtensionEntries` 与 `applyExtensionSourceInfo` 的注释）。
  applyExtensionSourceInfo(loaded.extensions, entries);
  for (const e of loaded.errors) errors.push(`扩展 ${shortPath(e.path)}：${e.error}`);
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
    extensionSessionManager(store, sessionId ?? (() => store.getState().trace.sessionId)) as never,
    extensionModelRegistry(effectiveRuntime) as never,
  );

  bindCore(runner, store, uiOptions, effectiveRuntime, onSendMessage);

  // 工具：同名的先注册者优先（与官方 `getAllRegisteredTools` 一个口径）。
  const seen = new Set<string>();
  const tools: AgentTool[] = [];
  const promptTools: PromptToolLike[] = [];
  for (const ext of loaded.extensions) {
    for (const [name, entry] of ext.tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      const d = entry.definition as ExtensionToolDefinition;
      if (typeof d.execute !== 'function') {
        errors.push(`扩展 ${shortPath(ext.path)}：工具 ${name} 没有 execute`);
        continue;
      }
      tools.push(adaptExtensionTool(name, d, { runner, store, cwd }));
      // prompt 片段：官方语义是「有 snippet 才进 prompt 的工具清单」。没有就是
      // 「不告诉模型它存在」，而那会与「工具在注册表里」矛盾 —— 所以那种情况报出来。
      if (d.promptSnippet === undefined || d.promptSnippet === '') {
        errors.push(
          `扩展 ${shortPath(ext.path)}：工具 ${name} 没有 promptSnippet —— 不会出现在 system prompt 里，模型不知道它存在`,
        );
      } else {
        promptTools.push({
          name,
          promptSnippet: d.promptSnippet,
          ...(d.promptGuidelines !== undefined && d.promptGuidelines.length > 0
            ? { promptGuidelines: [...d.promptGuidelines] }
            : {}),
        });
      }
    }
  }
  registerExtraTools(tools);

  // `before_agent_start` 的 handler 按注册顺序抄一份（官方 emitBeforeAgentStart 会
  // 重建 system prompt，本项目没那份可重拼的 options，所以自己调 —— 理由见
  // `extension-prompt.ts` 文件头）。
  const beforeAgentStart: BeforeAgentStartHandler[] = [];
  for (const ext of loaded.extensions) {
    for (const h of ext.handlers.get('before_agent_start') ?? []) {
      beforeAgentStart.push(h as BeforeAgentStartHandler);
    }
  }
  const onExtensionError = (where: string, message: string): void => {
    errors.push(`扩展 ${where}：${message}`);
  };

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
    entries: loaded.extensions.map((ext) => ({
      path: ext.path,
      source: ext.sourceInfo?.source ?? 'local',
      ...(ext.sourceInfo?.baseDir !== undefined ? { baseDir: ext.sourceInfo.baseDir } : {}),
      hidden: ext.hidden === true,
    })),
    loaded: loaded.extensions.length,
    beforeAgentStart: async (text?: string) => {
      await notifyBeforeAgentStart({
        handlers: beforeAgentStart,
        store,
        text,
        hasUI: uiOptions !== undefined,
        cwd,
        onError: onExtensionError,
      });
    },
    dispose: () => {
      runner.invalidate();
    },
  };
}

/** pi 的 `ExtensionToolContext` 里本项目**真的**实现了的那几个成员。 */
interface ExtensionToolDefinition {
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((u: { content: unknown[]; details?: unknown }) => void) | undefined,
    ctx: unknown,
  ): Promise<{ content?: unknown[]; details?: unknown } | AgentToolResult>;
}

/**
 * 把官方 runtime 接到本项目的 store / overlay 上。
 *
 * `ExtensionActions` 里有二十几个成员，其中大半是 pi 应用层的能力（换模型、改设置、
 * 换会话、树导航、MCP…）。本项目**不实现**它们 —— 下面给的是「不做事」的形状，不是
 * 「假做事」的形状：
 *
 * - 有意义的（`getActiveTools` / `setActiveTools` / `sendUserMessage` / `isIdle` /
 *   `getSystemPrompt`）接真的；
 * - 换了模型 / 换思考级别返回 rejected Promise 而不是 resolve 成 no-op：调用方
 *   （扩展）会看到失败并**告诉用户**，而静默成功会让模型名与实际不符却无人察觉。
 */
function bindCore(
  runner: ExtensionRunner,
  store: AgentStore,
  uiOptions: (() => HostUiOptions) | undefined,
  runtime: AgentRuntime,
  onSendMessage: ((text: string) => void) | undefined,
): void {
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
      getActiveTools: () => activeToolsFromState(store.getState()),
      // **真的有**，不是 `[]`。`pi-web-access` 的 `web_enable`（动态启用 web 工具的
      // loader 工具）就靠它判断「这些工具到底在不在」：`[]` 会让它以为一个都没有，
      // 于是回一句「Cannot enable unavailable tools: web_search, ...」——
      // 而那些工具明明就在注册表里。症状是「模型永远调不了 web_search」。
      getAllTools: () => allToolsInfo(),
      getSettings: () => ({}) as never,
      setActiveTools: (names: string[]) => {
        applyActiveTools(store, names);
      },
      // 工具集是**装载时**定下的（见文件头「一处刻制的偏差」），所以「刷新」无事可做。
      // 扩展若指望它生效会拿到一个静默 no-op —— 与 pi 的语义不同，这里是刻意的。
      refreshTools: () => {},
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
 * 官方的 `getAllTools()` 该看到什么 —— 就是**本项目的工具注册表**。
 *
 * 官方那份 `ToolInfo` 还带 `exposure` / `namespace` / `annotations` / `sourceInfo`。
 * 本项目只给 `exposure` 真的有意义的那个值（`direct`），其余给中性值：
 *
 * - `namespace` / `annotations`：MCP 与 codemode 那些机制的输入，本项目不接。
 * - `sourceInfo`：只用于显示（「这个工具来自哪个扩展」）。给一个合法形状就行 ——
 *   给 undefined 会让扩展在 `getAllTools().find(...)` 之后去读 `.sourceInfo.…`
 *   时炸在一个假字段上，而那个堆栈与真因隔了三层。
 */
function allToolsInfo(): ToolInfo[] {
  return getTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as ToolInfo['parameters'],
    exposure: 'direct' as const,
    sourceInfo: { source: 'local' } as ToolInfo['sourceInfo'],
  }));
}

/** 目录的短一点显示（错误信息里全路径太长，没人读得下去）。 */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

export { getTool };

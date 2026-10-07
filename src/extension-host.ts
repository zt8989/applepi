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
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AgentStore } from './store';
import type { AgentTool, AgentToolResult } from './agent-tool';
import { getTool, registerExtraTools } from './tools';
import { adaptExtensionTool, activeToolsFromState, applyActiveTools } from './extension-tools';
import { createHostUi, type ExtensionHostUi, type HostUiOptions } from './extension-ui';
import { notifyBeforeAgentStart, type BeforeAgentStartHandler } from './extension-prompt';
import { configHome } from './config-home';
import type { PromptToolLike } from './system-prompt';

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
  /** 装载诊断（扩展加载失败、注册了但形状不对…）。 */
  readonly errors: readonly string[];
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
  /** 测试注入：跳过整个装载流程。 */
  disabled?: boolean | undefined;
}

/** 空宿主：一个扩展都没有时的形状。 */
function emptyHost(errors: readonly string[] = []): ExtensionHost {
  return {
    tools: [],
    promptTools: [],
    errors,
    loaded: 0,
    beforeAgentStart: async () => {},
    dispose: () => {},
  };
}

/**
 * 读 `settings.json` 的 `packages`，解析成**扩展入口文件**的绝对路径。
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
 */
async function resolveExtensionEntries(cwd: string, errors: string[]): Promise<string[]> {
  let settings: SettingsManager;
  try {
    settings = SettingsManager.create(cwd, configHome(), { projectTrusted: true });
  } catch (error) {
    errors.push(`扩展：读 settings 失败 —— ${msg(error)}`);
    return [];
  }
  let paths: string[];
  try {
    const resolved = await new DefaultPackageManager({
      cwd,
      agentDir: configHome(),
      settingsManager: settings,
    }).resolve(async () => 'skip');
    paths = resolved.extensions.filter((r) => r.enabled).map((r) => r.path);
  } catch (error) {
    errors.push(`扩展：解析包失败 —— ${msg(error)}`);
    return [];
  }
  return paths;
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
  const { store, cwd, uiOptions, disabled } = options;
  if (disabled === true) return emptyHost();

  const errors: string[] = [];
  const entries = await resolveExtensionEntries(cwd, errors);
  if (entries.length === 0) return emptyHost(errors);

  const eventBus = createEventBus();
  const loaded = await loadExtensions(entries, cwd, eventBus);
  for (const e of loaded.errors) errors.push(`扩展 ${shortPath(e.path)}：${e.error}`);
  if (loaded.extensions.length === 0) return emptyHost(errors);

  // runner 要 sessionManager 与 modelRegistry。本项目**不接** pi 的会话与模型层 ——
  // 那正是「只用 pi 的样式层与工具，不接它的应用层」那条决定的延续。
  //
  // 传 `undefined as never` 而不是给假对象：扩展若去读它们的成员（列模型、读会话条目），
  // 会在那里炸出「cannot read property of undefined」—— 那比给一个**会静默说谎**的
  // 空实现好得多（后者会让扩展以为「没有可用模型」而改走另一条路，症状离真因很远）。
  // 第一个要接的扩展只用到 `ctx.ui` / `ctx.hasUI` / `ctx.cwd` / `ctx.isProjectTrusted()`，
  // 这四样我们都给真的。
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    cwd,
    undefined as never,
    undefined as never,
  );

  bindCore(runner, store, uiOptions);

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

  return {
    tools,
    promptTools,
    errors,
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
): void {
  const noUi = (what: string) => Promise.reject(new Error(`本项目不支持扩展的「${what}」`));
  runner.bindCore(
    {
      sendMessage: () => {},
      sendUserMessage: (content: unknown) => {
        const text = typeof content === 'string' ? content : String((content as { text?: unknown })?.text ?? '');
        if (text.trim() === '') return;
        store.dispatch({ type: 'user.message', text } as never);
      },
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => activeToolsFromState(store.getState()),
      getAllTools: () => [],
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

/** 目录的短一点显示（错误信息里全路径太长，没人读得下去）。 */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.length <= 2 ? p : parts.slice(-2).join('/');
}

export { getTool };

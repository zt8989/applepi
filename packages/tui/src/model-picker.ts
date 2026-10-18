/**
 * TUI 的「换模型」弹窗 —— `/model`（或 `app.model.select`）打开。
 *
 * ## 为什么直接用 pi 官方的 `ModelSelectorComponent`
 *
 * 与 `/resume`（见 `session-picker.ts`）**同一个理由**：这个面板的交互面很宽，而每一条都要与
 * pi 对齐才有意义（用户已经习惯了 `Ctrl+S` 存默认、`default` 前缀搜默认模型、
 * 「当前模型置顶 + 打勾」）：
 *
 * ```text
 *   ────────────────────────────────────────────────
 *   Only showing models from configured providers. Use /login to add providers.
 *   > 搜索…
 *   → ✓ cn:space-bunny [workbuddy] · default
 *       cn:deepseek-v4.1-flash [workbuddy]
 *       cn:glm-5.3-flash [workbuddy]
 *
 *     Model Name: cn:space-bunny
 *
 *     Model catalogs refreshed.
 *   Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel
 *   ────────────────────────────────────────────────
 * ```
 *
 * 手写这套要复刻 `model-selector.js` + `model-catalog-refresh.js`（后台刷目录、15s 超时、
 * 错误分级文案、模糊搜索 + `default` 特例、当前模型置顶排序、`Model Name:` 那行、滚动指示
 * `(3/12)`）约 200 行，而且**必然与上游漂移**。所以这里是**适配层**，不是重写。
 *
 * | 官方要什么 | 我们给 |
 * | --- | --- |
 * | `ModelRuntime` | `runtime.runtime`（主路径）或 `fallbackModelRuntime()`（降级，见文件头） |
 * | `currentModel` | 当前 `state.model`（底栏那一栏就是它） |
 * | `scopedModels` | 内核当前的作用域列表（`/scoped-models` 改的那份） |
 * | `defaultModel` | `settings.json` 的 `defaultProvider` / `defaultModel` |
 * | `onSelectAsDefault` | `SettingsManager.setDefaultModelAndProvider()` |
 * | `keybindings` | `installProjectKeybindings()` 并装到 pi-tui 全局（与 `/resume` 同一句理由） |
 *
 * ## 但**换模型要真的换**（与 `/resume` 那一处最大的不同）
 *
 * 选完之后不能只 `showStatus()` —— 那是 pi 的 `InteractiveMode` 能这么干的原因：它有
 * `session.setModel()`。本项目的状态**只能由 action 改**（reducer 纯函数那条不变式），所以
 * 换模型是 `kernel.setModel()`：它 dispatch 一条 `model.changed`（带全能力 / 窗口），而 **effect 表
 * 读的模型是从 state 里取的**（见 `effects.ts` 里 `modelOf(state)`）。
 *
 * ## 降级路径：手写一个最小门面，而不是让面板不可用
 *
 * `ModelRuntime.create()` 失败时 `provider.ts` 退回手写装配（`runtime.runtime` 是
 * `undefined`）。官方组件的构造签名要一个 `ModelRuntime`，硬传 `undefined` 会在
 * `getAvailableSnapshot()` 那一行就崩 —— 症状是「按 `/model` 什么都不发生」。
 *
 * 所以给一个**只实现组件用到的那几个方法**的门面：模型列表来自 `models.getModels()`
 * （手写装配也有，那是 pi-ai 的 `Models` 接口），`refresh()` 报「不可用」而不是假装成功。
 * 面板能列、能搜、能选 —— 只是列出来的是 models.json 里的那几个，而不是 1500+ 内置目录。
 */
import { ModelSelectorComponent } from '@earendil-works/pi-coding-agent';
// `ScopedModelsSelectorComponent` **不在**主入口的导出里（只有 `ModelSelectorComponent` 有），
// 所以走子路径 —— 与 `session-picker.ts` 引 `SessionSelectorComponent` 同一层理由。
import { ScopedModelsSelectorComponent } from '@earendil-works/pi-coding-agent/dist/modes/interactive/components/scoped-models-selector.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent/dist/core/model-runtime.js';
import type { Model } from '@earendil-works/pi-ai';
import type { ViewportTUI } from '@earendil-works/pi-tui';
import type { AgentRuntime } from '@ela/core/provider';
import { installProjectKeybindings } from './keybindings';
import { composerOverlayOptions } from './composer-overlay';
import {
  defaultModelRef,
  readScopedModels,
  writeScopedModels,
  type ModelScope,
} from '@ela/core/model-scope';

export interface ModelPickerOptions {
  tui: ViewportTUI;
  /** 内核的 provider 装配（`AgentRuntime`）。降级路径也在（见文件头）。 */
  runtime: AgentRuntime;
  /** 当前模型（底栏那一栏就是它；面板用它打勾、把它置顶）。 */
  current: { provider: string; modelId: string };
  /** 换了模型之后要真的换（内核出手，见文件头「换模型要真的换」）。 */
  onSelect(model: Model<any>): void;
  /** 存成默认（`Ctrl+S`）。 */
  onSelectAsDefault(model: Model<any>): void;
  /** 换了作用域（`/scoped-models` 之后）→ 重开面板时读最新那份。 */
  scope?: ModelScope;
  /** 当前进程 cwd（`SettingsManager.create` 要它来分层读 settings）。 */
  cwd: string;
}

/**
 * 降级路径的门面：让官方组件的 `getAvailableSnapshot()` / `getModel()` / `getError()`
 * 有东西可调。
 *
 * ## 为什么**不**做 `refresh()`
 *
 * 官方组件在构造后会 `void this.refreshModels()`，它调 `modelRuntime.refresh()`。
 * 那个方法在主路径会去**打网络**（1500+ 模型目录）。降级路径上没有 `ModelsStore`
 * 可刷，硬造一个只会得到一个「刷新失败」的绿字/红字，而用户什么也没得到。
 *
 * 所以 `refresh()` 直接抛，官方组件的 `catch` 会把 `refreshStatusMessage` 置空、
 * `errorMessage` 填上——面板照常列模型、照常能搜能选，只是多一行明说原因的红字。
 * 这比「假成功」诚实：假成功会让用户以为目录已经是新的。
 */
function fallbackModelRuntime(runtime: AgentRuntime): ModelRuntime {
  const models = runtime.models;
  const snapshot = (): readonly Model<any>[] => {
    // `getModels()` 不传 provider 就是全部（pi-ai 的 `Models` 接口语义）。
    return models.getModels();
  };
  return {
    getAvailableSnapshot: snapshot,
    getModels: (providerId?: string) => models.getModels(providerId),
    getModel: (provider: string, modelId: string) => models.getModel(provider, modelId),
    getProviders: () => models.getProviders(),
    getError: () => runtime.runtime?.getError?.(),
    refresh: async () => {
      throw new Error('ModelRuntime 不可用（provider 装配已降级），模型目录没法刷新');
    },
  } as unknown as ModelRuntime;
}

/** 拿能喂给官方组件的那个 runtime：主路径给真的，降级给门面。 */
export function modelRuntimeFor(runtime: AgentRuntime): ModelRuntime {
  return (runtime.runtime as unknown as ModelRuntime | undefined) ?? fallbackModelRuntime(runtime);
}

/** 真的那个 `ModelRuntime`（降级时 `undefined`）。测试与目录刷新要用真的那个。 */
export function realModelRuntime(runtime: AgentRuntime): ModelRuntime | undefined {
  return runtime.runtime as unknown as ModelRuntime | undefined;
}

/**
 * 当前模型对象（面板打勾用它）。
 *
 * 拿不到就 `undefined`：官方组件接受 `currentModel: undefined`（此时不打勾、也不置顶），
 * 而我们**不**该编一个只有 id 的假 Model 塞进去 —— `modelsAreEqual` 会去读
 * `provider`/`id` 之外的字段。
 */
function currentModelOf(runtime: AgentRuntime, current: { provider: string; modelId: string }): Model<any> | undefined {
  return modelRuntimeFor(runtime).getModel(current.provider, current.modelId);
}

/**
 * 打开模型选择弹窗。
 *
 * @returns 弹窗的关闭函数（与 `openSessionPicker` 同一形状）。
 */
export function openModelPicker(options: ModelPickerOptions): () => void {
  const { tui, runtime, cwd } = options;

  // 装键位表到 pi-tui 全局 —— 与 `session-picker.ts` 同一句理由：
  // `app.models.save`（Ctrl+S）在 pi-tui 默认那份里**不存在**，不装的话它恒为 false，
  // 于是「Ctrl+S 存默认」**静默失效**，连那行提示都会一起消失。
  //
  // 用 `installProjectKeybindings()` 而不是 pi 的 `KeybindingsManager.create()`：
  // 那份**不含**本项目自己的动作（`app.trace.toggle` 等），覆盖掉全局之后
  // 顶行那块 `(Ctrl+R)` 会变成 `()`。只有一处创建才不会出现这种“谁最后装谁说话”。
  installProjectKeybindings();

  // 默认模型：官方组件拿它排「· default」并支持搜 `default` 前缀直达。
  // 读法与「读作用域」都在 `model-scope.ts` 里（那里才是 settings 那一侧的唯一入口）——
  // 这里不再自己读一遍 settings：两份读法会漂移，而漂移的症状是「面板上那个
  // `· default` 与 Ctrl+S 刚存进去的那个不是同一个」。
  const defaultRef = defaultModelRef(cwd, modelRuntimeFor(runtime));

  const selector = new ModelSelectorComponent(
    tui as never,
    currentModelOf(runtime, options.current),
    modelRuntimeFor(runtime),
    // 作用域：官方用它算 `Scope: all | scoped` 与 `tab` 切换。没配过作用域就传空数组
    // （官方据此显示「Only showing models from configured providers」那一行黄字提示）。
    options.scope?.models ?? [],
    (model) => {
      close();
      options.onSelect(model);
    },
    () => {
      close();
      tui.requestRender();
    },
    // `initialSearchInput`：`/model xxx` 带的词。`/model` 不带就 `undefined`。
    // 传 `''` 与传 `undefined` 在官方那里**不一样**（`''` 是「显式空串」，
    // 走 `if (initialSearchInput)` 的 falsy 分支，但语义上要说清我们没带词）。
    undefined,
    (model) => {
      close();
      options.onSelectAsDefault(model);
    },
    defaultRef,
  );

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    // 官方组件起了一个后台 refresh（带 15s 超时 + AbortController）。不 dispose 的话
    // 那个定时器会活到超时——用户早就关掉面板了，它还在那儿。
    selector.dispose();
    handle?.hide();
  }

  // 覆盖层：**盖住 composer**（不是居中浮窗）—— 满宽、底边与 composer 底边齐平，
  // 与 pi 的 `showSelector()` 换掉 `editorContainer` 内容同一形状。
  // 为什么这么摆、`margin.bottom` 为什么跟着底栏走，见 `composer-overlay.ts`。
  //
  // ## 为什么**不**给 `maxHeight`（这里曾经是 `'80%'`）
  //
  // pi-tui 对 `maxHeight` 的处理是 `overlayLines.slice(0, maxHeight)` —— **从尾部切**，
  // 切掉的正是最后几行：那行按键提示（「Enter to select · Ctrl+S to set as default ·
  // Esc to cancel」）与下框线。而本面板渲染出来 24 行（上框线 + 黄字提示 + 搜索框 +
  // 10 行模型 + 滚动指示 + `Model Name:` + 后台刷新状态 + 按键提示 + 下框线），30 行的
  // 终端下 `70%` 只有 21 行 —— 必切。
  //
  // 早先为此把比例调到 `80%`（24/30 ≈ 80%），但那是**算着终端高度**去躲切片，终端一矮
  // 还是会切。现在干脆不给上限：面板按内容自然展开、向上盖住对话区，一行都不丢。需要
  // 控高时由组件自己决定（它内部本来就有列表行数上限）。
  const handle = tui.showOverlay(selector, composerOverlayOptions());

  return close;
}

// ─── 作用域（Ctrl+P 循环的候选集） ───

/**
 * `/scoped-models` —— 启用/禁用哪些模型参与 `Ctrl+P` 循环。
 *
 * ## 为什么也直接用官方的 `ScopedModelsSelectorComponent`
 *
 * 与上面同一个理由，而且更极端：这一屏要处理 6 个键（`Ctrl+S` 存 / `Ctrl+A` 全开 /
 * `Ctrl+X` 全关 / `Ctrl+E` 整个 provider / `Alt+↑↓` 调顺序），每一条都要与 pi 同键同义。
 * 官方的 `enabledIds === null`（「全开」这个特例）、`normalizeEnabled()`（显式列表刚好覆盖
 * 全部时折叠回 `null`）、toggle/clear/reorder 的边界处理（越界不动、`null` 时 reorder 无效）
 * 都是踩过坑的代码。复刻它等于复刻一份副本。
 *
 * ## 作用域是**会话级**的（`state` 之外的内存）
 *
 * 与 pi 一致：改了当场生效（`onChange`），`Ctrl+S` 才写进 `settings.json` 的
 * `enabledModels`。为什么放 state 之外：它**不是**「这次对话的事实」，而是「本会话用哪几个
 * 模型循环」——放 state 会被 `conversation.reset` / `restored` 的字段清单牵连
 * （那两处已经各有一份「哪些要带着走」的清单，见 `reducer.ts` 的 `restoredConversationState`）。
 */
export interface ScopedModelsOptions {
  tui: ViewportTUI;
  runtime: AgentRuntime;
  cwd: string;
  /** 改了就地生效（会话内，`Ctrl+P` 的循环集立刻变）。 */
  onChange(enabledIds: readonly string[] | null): void;
  /**
   * `Ctrl+S`：写进 `settings.json` 的 `enabledModels`。
   *
   * 第二个参数是**写成功没有** —— 调用方要据此报一行（写失败静默的话，用户以为存下了，
   * 下次启动发现没了）。
   */
  onPersist(enabledIds: readonly string[] | null, written: boolean): void;
  /** 换作用域之后要重建的 `ModelSelectorComponent` 的 scope 参数（内存里给回调用）。 */
  currentScope?: ModelScope;
}

export function openScopedModelsPicker(options: ScopedModelsOptions): () => void {
  const { tui, runtime, cwd } = options;

  // 与上面同一句理由：`app.models.*` 在 pi-tui 默认那份里没有，不装就全静默失效。
  installProjectKeybindings();

  // 全集 = 当前可用快照（`Ctrl+A` / `Ctrl+X` 的「全部」就是它的全集）。
  const allModels = [...modelRuntimeFor(runtime).getAvailableSnapshot()];
  // **先会话内、后盘上**：本会话改过的（`/scoped-models` 改完没存）比盘上的新。
  // 反过来的话，用户改了半天没按 `Ctrl+S` 就重开面板，看到的却是上次存的 ——
  // 症状是「我明明刚改了」。
  const configured = options.currentScope?.enabledModelIds ?? readScopedModels(cwd);

  // 官方组件要**显式列表或 null**。`null` = 全开（官方那个 `isEnabled` 的特例）。
  const enabledModelIds = configured === null || configured.length === 0 ? null : [...configured];

  const selector = new ScopedModelsSelectorComponent(
    {
      allModels,
      enabledModelIds,
      // refreshStatus 不给：官方那一行是「刷新目录」的进度，而我们没在刷
      // （见 fallbackModelRuntime 的 refresh 注释）。给一个假的进度行等于撒谎。
    },
    {
      onChange: (ids: string[] | null) => {
        options.onChange(ids);
      },
      onPersist: (ids: string[] | null) => {
        // 写盘失败要**说出来** —— 与 `/model` 面板里 `Ctrl+S` 那条同一处理。
        // 静默失败的话，用户以为存下了，下次启动发现没了。
        const ok = writeScopedModels(ids === null ? null : [...ids], cwd);
        options.onPersist(ids, ok);
      },
      onCancel: () => {
        close();
        tui.requestRender();
      },
    },
  );

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    handle?.hide();
  }

  // 与 `/model` 那个面板同一形状（同一份参数，见 `composer-overlay.ts`）。
  const handle = tui.showOverlay(selector, composerOverlayOptions());

  return close;
}

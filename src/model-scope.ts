/**
 * 模型作用域（`Ctrl+P` 循环的候选集）—— `/scoped-models` 改的就是它。
 *
 * ## 为什么不放 state
 *
 * 因为它**不是「这次对话的事实」**，而是「这个会话拿哪几个模型循环」。state 里的东西会被
 * `conversation.reset` / `conversation.restored` / `trace.restored` 三处各带一次
 * （`reducer.ts` 的 `restoredConversationState` 把「哪些要跟着走」列成了一份清单）——
 * 作用域进 state 就得在那份清单里再加一项，而漏掉它的症状是「`/new` 之后循环集莫名变了」，
 * 比「作用域不跟着恢复」更难归因。
 *
 * 所以它是**一个内存里的对象 + 一个 settings 键**（与 pi 完全一致：会话内生效，
 * `Ctrl+S` 才落盘）。
 *
 * ## 落盘用 `settings.json` 的 `enabledModels`（与 pi 同一个键）
 *
 * `~/.pi/agent/settings.json` 是共用的（`pi-config.ts` 的 `configHome()` 就是 pi 的
 * `getAgentDir()`），所以这里写的 `enabledModels` **pi 那边也认**。写之前先读
 * `SettingsManager` 已有的值再合并，而不是整份覆写 —— settings.json 里有 `theme`、
 * `defaultProvider`、项目信任等等一堆别的键，整份覆写会把它们全弄丢。
 */
import type { Model } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import { piAgentDir } from './pi-config';
import { fallbackProviderSpec } from './provider';

/**
 * 一个作用域条目：模型 + 可选的思考级别（`provider/id:high` 那种带级别的写法）。
 *
 * ## 形状必须与官方 `ModelSelectorComponent` 的 `scopedModels` 逐字一致
 *
 * 那个接口在 `scoped-models-selector.d.ts` 里**没有导出**（只作为构造参数的结构类型存在），
 * 而本项目开了 `exactOptionalPropertyTypes` —— 所以 `thinkingLevel?: string | undefined`
 * 与官方的 `thinkingLevel?: string` **不是**同一个类型（前者多允许显式 undefined）。
 * 复制一份过来时把 `| undefined` 去掉，否则 `scope.models` 传进官方构造会报类型不匹配，
 * 而那类 cast 会把一个真类型错误压成运行时崩溃。
 */
export interface ScopedModelItem {
  model: Model<any>;
  thinkingLevel?: string;
}

export interface ModelScope {
  /**
   * 启用列表。`null` = **全开**（官方的特例：显式列表刚好处���全集时会折叠回 `null`）。
   *
   * 为什么是「全开」而不是「此刻的全集」：provider 的模型目录会随 refresh 变化
   * （网关加了个新模型），「全开」要跟着变，而存一份具体列表就固化了。
   */
  readonly enabledModelIds: readonly string[] | null;
  /** 面板要显示的条目（`enabledModelIds` 解析出来的）。 */
  readonly models: readonly ScopedModelItem[];
}

/** 空作用域：全开、列表空（官方据此显示「only configured providers」那一行提示）。 */
export const NO_SCOPE: ModelScope = { enabledModelIds: null, models: [] };

/**
 * 读 `settings.json` 的 `enabledModels`。
 *
 * 读不到 / 不是数组 / 空 → `null`（= 全开）。**空数组也当全开**：官方那边
 * 「全部禁用」会被 `normalizeEnabled()` 折叠回去，落到盘上写成 `[]` 与不写是同一件事，
 * 区别只在本次会话的临时状态。
 */
export function readScopedModels(cwd: string = process.cwd()): string[] | null {
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    const patterns = settings.getEnabledModels();
    if (!Array.isArray(patterns) || patterns.length === 0) return null;
    return patterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  } catch {
    // settings.json 读不了（坏 JSON / 没权限）。**不抛**：作用域是可选功能，
    // 读不到就当「没配过」（= 全开），面板照常能开。
    return null;
  }
}

/** 写 `settings.json` 的 `enabledModels`。`null` = 删掉这个键（回到「全开」）。 */
export function writeScopedModels(
  patterns: readonly string[] | null,
  cwd: string = process.cwd(),
): boolean {
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    settings.setEnabledModels(patterns === null ? undefined : [...patterns]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 默认模型引用（`settings.json` 的 `defaultProvider` / `defaultModel`）。
 *
 * 官方 `ModelSelectorComponent` 拿它排「· default」并支持搜 `default` 前缀直达。
 * 两个键要**同时**有才算（只有 `defaultModel` 没有 provider 是配坏了的形态 ——
 * 那时给一个半截引用会让「· default」挂在一个解析不出来的模型上）。
 *
 * 读不到时用**同一个**动态兜底（`provider.ts` 的 `fallbackProviderSpec()`：models.json
 * 里的第一个 provider；再不行就是内置的 `anthropic`）。**不写死任何一个 provider 名** ——
 * 早先这里与 `provider.ts` 都写死 `workbuddy` / `cn:space-bunny`，症状是换台机器（配置家目录
 * 里没这个 provider）时启动就报「未知 provider：workbuddy」，而面板上那个 `· default`
 * 也挂着一个解析不出来的模型。
 *
 * 两者共享同一个函数是刻意的：写死两遍、或各写一份兜底，症状就是「启动用的默认」与
 * 「面板上标 default 的那个」在配置不同时对不上 —— 而它们本该是同一个东西。
 */
/**
 * 面板上的 `· default`（provider + 模型 id）。
 *
 * 官方 `DefaultModelReference` 的 `id` 是必填的 `string`，所以拿不到具体模型时只能
 * 返回 `undefined`（官方组件接受它 —— 那样就只是不显示 `· default` 那一行）。
 *
 * `runtime` 用来把「只有 provider」补成「provider + 它的第一个模型」：兜底选的 provider
 * 来自 models.json 的**第一个**条目时，它的第一个模型本来就在 models.json 里；而
 * 兜底退到内置 `anthropic` 时目录有 1500 条，得问 runtime 才不猜。
 *
 * 不传 `runtime`（测试、纯 settings 读取）时没有模型可补，就返回 undefined。
 */
export function defaultModelRef(
  cwd: string = process.cwd(),
  runtime?: { getModels(providerId?: string): readonly { id: string }[] },
): { provider: string; id: string } | undefined {
  const fallback = fallbackProviderSpec();
  let provider: string;
  let id: string | undefined;
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    provider = settings.getDefaultProvider() ?? fallback.provider;
    id = settings.getDefaultModel() ?? fallback.model;
  } catch {
    provider = fallback.provider;
    id = fallback.model;
  }
  // 兜底只给了 provider（models.json 空目录）：问 runtime 要该 provider 的第一个模型。
  if (id === undefined) id = runtime?.getModels(provider)[0]?.id;
  return id === undefined ? undefined : { provider, id };
}

/** 写默认模型（`/model` 面板里 `Ctrl+S` 那条）。 */
export function writeDefaultModel(provider: string, modelId: string, cwd: string = process.cwd()): boolean {
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    settings.setDefaultModelAndProvider(provider, modelId);
    return true;
  } catch {
    return false;
  }
}

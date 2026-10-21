/**
 * 模型作用域（`Ctrl+P` 循环的候选集）—— `/scoped-models` 改的就是它。
 *
 * 不放 state：它不是「这次对话的事实」，而是「这个会话拿哪几个模型循环」。进 state 就得在
 * `restoredConversationState` 的恢复清单里再加一项，漏掉的症状是「`/new` 之后循环集莫名变了」。
 *
 * 所以它是一个内存里的对象 + 一个 settings 键（与 pi 一致：会话内生效，`Ctrl+S` 才落盘）。
 *
 * 落盘用 `settings.json` 的 `enabledModels`，pi 那边也认（`configHome()` 就是 pi 的
 * `getAgentDir()`）。写之前先读已有值再合并，**不整份覆写** —— 那份文件里还有 `theme`、
 * `defaultProvider`、项目信任等一堆键。
 */
import type { Model } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent/dist/core/settings-manager.js';
import { piAgentDir } from './pi-config';
import { fallbackProviderSpec } from './provider';

/**
 * 一个作用域条目：模型 + 可选的思考级别（`provider/id:high` 那种带级别的写法）。
 *
 * 形状必须与官方 `ModelSelectorComponent` 的 `scopedModels` 逐字一致。那个接口没有导出，
 * 而本项目开了 `exactOptionalPropertyTypes` —— 所以这里**不能**写
 * `thinkingLevel?: string | undefined`（与官方的 `thinkingLevel?: string` 不是同一个类型），
 * 否则传进官方构造会报类型不匹配，而那类 cast 会把真类型错误压成运行时崩溃。
 */
export interface ScopedModelItem {
  model: Model<any>;
  thinkingLevel?: string;
}

export interface ModelScope {
  /**
   * 启用列表。`null` = **全开**（官方的特例：显式列表恰好等于全集时会折叠回 `null`）。
   *
   * 存「全开」而不是「此刻的全集」：provider 的模型目录会随 refresh 变化，「全开」跟着变，
   * 存一份具体列表就固化了。
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
 * 读不到 / 不是数组 / 空 → `null`（= 全开）。**空数组也当全开**：官方那边「全部禁用」会被
 * `normalizeEnabled()` 折叠回去，落到盘上 `[]` 与不写是同一件事。
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
 * 面板上的 `· default`（provider + 模型 id），读 `settings.json` 的 `defaultProvider` /
 * `defaultModel`。两个键要**同时**有才算 —— 只有 model 没有 provider 是配坏了的形态，
 * 给一个半截引用会让 `· default` 挂在解析不出来的模型上。
 *
 * 读不到时用 `provider.ts` 的 `fallbackProviderSpec()` 兜底（models.json 的第一个 provider，
 * 再不行是内置 `anthropic`）。**不写死任何 provider 名**：写死的话换台机器配置里没这个
 * provider 时，启动就报「未知 provider」。与 `provider.ts` 共用同一个兜底也是刻意的 ——
 * 各写一份，症状是「启动用的默认」与「面板上标 default 的那个」对不上。
 *
 * 官方 `DefaultModelReference` 的 `id` 是必填 `string`，所以拿不到具体模型时只能返回
 * `undefined`（官方组件接受它 —— 那就不显示 `· default` 那一行）。`runtime` 用来把
 * 「只有 provider」补成「provider + 它的第一个模型」：兜底退到内置 `anthropic` 时目录有
 * 1500 条，得问 runtime 才不猜。
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

/**
 * 思考块是否默认折叠（`settings.json` 的 `hideThinkingBlock`）。
 *
 * 与 pi **同一个键、同一个文件**：在 pi 那边折过一次之后，本项目启动时也默认折叠。
 * 读不到（没配过 / 文件坏了 / 没权限）就当 `false`（与 pi 的 `?? false` 一致）。
 *
 * 同步读：界面启动那一刻就要这个值（决定首次渲染怎么画思考块），而那里不是 async 上下文。
 */
export function readHideThinkingBlock(cwd: string = process.cwd()): boolean {
  try {
    return SettingsManager.create(cwd, piAgentDir()).getHideThinkingBlock();
  } catch {
    return false;
  }
}

/**
 * 写 `hideThinkingBlock`（`Ctrl+T` 切换时落盘，与 pi 的 `setHideThinkingBlock` 同一效果）。
 *
 * 必须 `await flush()`：pi 的 `save()` 是入队异步写，`setHideThinkingBlock()` 返回时可能
 * 一个字节都还没落盘 —— 调用方紧接着读到旧值，写失败也拿不到。
 */
export async function writeHideThinkingBlock(hide: boolean, cwd: string = process.cwd()): Promise<boolean> {
  try {
    const settings = SettingsManager.create(cwd, piAgentDir());
    settings.setHideThinkingBlock(hide);
    await settings.flush();
    return settings.drainErrors().length === 0;
  } catch {
    return false;
  }
}

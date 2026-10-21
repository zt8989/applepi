/**
 * 设置面板「模型」分区（可用模型 / 作用域）的纯逻辑。
 *
 * 这里不碰 DOM：把 `GET /api/models` 的回执摊成一份可改的状态（哪些模型开着、
 * 哪些作用域条目在目录里找不到），再把状态折回 `POST /api/scoped-models` 要的
 * `ids`。界面只负责画与点（`settings-panel.ts`），单测只测这一份
 * （`test/pure.test.ts`）。
 *
 * ## 为什么要把「原来的条目」留着
 *
 * `enabledModels` 的条目可以带思考级别后缀（`provider/id:high`）。原实现每次勾选都
 * 用 `provider/id` 重建整份作用域 —— 手写的 `:high` 会在下一次点击时静默消失。
 * 所以这里记住「key → 原来的那条」，保存时优先写回原条目。
 *
 * 目录里**对不上**的条目（provider 下线、手改 settings.json 写错）也原样留着：
 * 我们看不懂它，但删掉它就是在替用户做决定。只有「全部开启」会真的清空作用域
 * （那本来就是「不限制」的意思）。
 */

import type { WebModelRef, WebModelsInfo } from '@ela/core/web-protocol';
import { scopePatternKey } from './model-picker';

/** `provider/id` —— 目录与作用域共用的 key。 */
export const modelRef = (model: Pick<WebModelRef, 'provider' | 'id'>): string =>
  `${model.provider}/${model.id}`;

export interface ScopeState {
  /** 目录里的全部模型（顺序用服务端给的，不再排）。 */
  models: readonly WebModelRef[];
  /** 现在开着的模型 key。 */
  enabled: Set<string>;
  /** 开着的模型 key → `settings.json` 里原来那条（可能带 `:high`）。 */
  patterns: Map<string, string>;
  /** 作用域里有、目录里没有的条目（保存时原样留着）。 */
  extras: string[];
  /** 当前会话用的模型（列表里标「当前」）。 */
  current: { provider: string; id: string } | null;
}

/** 把接口回执摊成可改状态。`scoped === null` = 全开。 */
export function buildScopeState(info: WebModelsInfo): ScopeState {
  const known = new Set(info.models.map(modelRef));
  const enabled = new Set<string>();
  const patterns = new Map<string, string>();
  const extras: string[] = [];

  if (info.scoped === null) {
    for (const key of known) enabled.add(key);
  } else {
    for (const pattern of info.scoped) {
      const key = scopePatternKey(pattern);
      if (!known.has(key)) {
        extras.push(pattern);
        continue;
      }
      enabled.add(key);
      patterns.set(key, pattern);
    }
  }

  return { models: info.models, enabled, patterns, extras, current: info.current };
}

/** 保存失败要退回改前的样子 —— 界面不能显示没写进 settings.json 的值。 */
export function cloneScopeState(state: ScopeState): ScopeState {
  return {
    models: state.models,
    enabled: new Set(state.enabled),
    patterns: new Map(state.patterns),
    extras: [...state.extras],
    current: state.current,
  };
}

/** 开着几个 / 一共几个（面板顶部那句 `8/12 已启用`）。 */
export function enabledCount(state: ScopeState): { enabled: number; total: number } {
  let enabled = 0;
  for (const model of state.models) {
    if (state.enabled.has(modelRef(model))) enabled += 1;
  }
  return { enabled, total: state.models.length };
}

/** 某个 provider 下的全部 key（provider 那一行整组开关用）。 */
export function providerKeys(state: ScopeState, provider: string): string[] {
  return state.models.filter((model) => model.provider === provider).map(modelRef);
}

/**
 * 把 `keys` 里这些模型关掉之后还剩几个开着。
 *
 * 服务端的 `setScopedModels([])` 会归成 `null`（= 全开），所以「关掉最后一个」不是
 * 「一个都没有」而是「全部回来」—— 界面必须在点下去之前拦住（与 pi-web 的
 * 「至少留一个」同一个道理）。返回 0 就是不能关。
 */
export function remainingEnabled(state: ScopeState, keys: readonly string[]): number {
  const removing = new Set(keys);
  let remaining = 0;
  for (const model of state.models) {
    const key = modelRef(model);
    if (state.enabled.has(key) && !removing.has(key)) remaining += 1;
  }
  return remaining;
}

/** 单个模型开 / 关。关掉时保留原来的 `:high` 条目，重新打开还是那个档位。 */
export function toggleModel(state: ScopeState, key: string, on: boolean): void {
  if (on) state.enabled.add(key);
  else state.enabled.delete(key);
}

/** 一整个 provider 开 / 关（pi-web 的 provider 开关）。 */
export function setProviderEnabled(state: ScopeState, provider: string, on: boolean): void {
  for (const key of providerKeys(state, provider)) toggleModel(state, key, on);
}

/** 全开：清空作用域，连带清掉对不上的旧条目（`settings.json` 不再有 `enabledModels`）。 */
export function setAllEnabled(state: ScopeState): void {
  state.enabled.clear();
  for (const model of state.models) state.enabled.add(modelRef(model));
  state.patterns.clear();
  state.extras.length = 0;
}

/**
 * 折回接口要的 `ids`。
 *
 * - 全部开着、没有对不上的旧条目、也没有 `:high` 这类条目 → `null`（= 全开，
 *   与 TUI 的 `normalizeEnabled()` 同一个口径）；
 * - 否则写回「原来的条目优先」的那一份，外加目录里对不上的旧条目。
 */
export function scopePayload(state: ScopeState): string[] | null {
  const ids = state.models
    .filter((model) => state.enabled.has(modelRef(model)))
    .map((model) => state.patterns.get(modelRef(model)) ?? modelRef(model));
  const plain = ids.every((id) => scopePatternKey(id) === id);
  if (ids.length === state.models.length && state.extras.length === 0 && plain) return null;
  return [...state.extras, ...ids];
}

/**
 * 按 provider 归堆，保持服务端给的顺序（`Map` 的插入序）。
 *
 * pi-web 的 `ModelSelector` 也不重排 —— `models.json` 里 provider 的顺序是用户写的。
 */
export function groupByProvider(
  models: readonly WebModelRef[],
): [provider: string, models: WebModelRef[]][] {
  const groups = new Map<string, WebModelRef[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group === undefined) groups.set(model.provider, [model]);
    else group.push(model);
  }
  return [...groups];
}

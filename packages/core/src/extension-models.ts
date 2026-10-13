/**
 * 扩展的 `ctx.modelRegistry` —— 扩展要拿模型与凭证时的那扇门。
 *
 * ## 为什么要接它
 *
 * `pi-web-access` 的**答案/摘要**功能要**自己调模型**（抓完页面要一个模型来读它、
 * 搜索结果要一个模型来总结）。它怎么拿凭证？只认 `ctx.modelRegistry`：
 *
 * ```js
 * const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
 * if (!auth.ok || !auth.apiKey) throw new Error(`No API key available for ${model.provider}/${model.id}`);
 * ```
 *
 * 早先这里传的是 `undefined`（pi 的 runner 构造器第 4、5 个参数），于是那些功能
 * 一被触发就是 `Cannot read properties of undefined (reading 'getApiKeyAndHeaders')`。
 *
 * ## 用官方的 `ModelRegistry`，不自己实现
 *
 * pi 自己的说明写着它是「给扩展用的同步兼容门面」，内部就是一层薄薄的方法转发。
 * 我们**已经有**那个 `ModelRuntime`（`provider.ts` 的主路径，主路径下它自带 44 个内置
 * provider 与 1500+ 模型目录，见 `provider.md`）。所以这里只是：
 *
 * ```ts
 * new ModelRegistry(runtime)     // 官方类，不是我们的实现
 * ```
 *
 * 凭证优先级、OAuth、`baseUrl` 拼接、headers —— 全是官方那份逻辑。自己写一遍就是
 * 一份会漂移的副本，而漂移的代价是「pi 那边能拿到 key，这边拿不到」。
 *
 * ## 降级路径上没有它
 *
 * `ModelRuntime.create()` 失败时 `provider.ts` 会退回手写装配（`runtime` 是
 * `undefined`）。那时我们**不造**这个 registry —— 于是 `ctx.modelRegistry` 是
 * `undefined`，扩展在要用的时候抛「cannot read property of undefined」。
 * 那与「给它一个会静默说『没有 key』的假 registry」相比诚实：后者会让扩展以为
 * 用户没配 key（于是回一句「No API key available for …」），而真因是**降级了**。
 */
import { ModelRegistry } from '@earendil-works/pi-coding-agent/dist/core/model-registry.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent/dist/core/model-runtime.js';
import type { AgentRuntime } from './provider';

/** 扩展看到的那一小面（`ModelRegistry` 真实用到的那几个）。 */
export interface ExtensionModelRegistry {
  getAll(): unknown[];
  getAvailable(): unknown[];
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<unknown>;
  isUsingOAuth(model: unknown): boolean;
  hasConfiguredAuth(model: unknown): boolean;
}

/**
 * 从我们的 `AgentRuntime` 造一个扩展能用的 model registry。
 *
 * **降级路径返回 `undefined`**（见文件头「降级路径上没有它」）。调用方（`extension-host.ts`）
 * 直接把它当 `ctx.modelRegistry` 交出去 —— 于是那条路上扩展拿到 undefined，
 * 而不是 一个说谎的对象。
 */
export function extensionModelRegistry(runtime: AgentRuntime): ExtensionModelRegistry | undefined {
  // `runtime` 只在主路径（ModelRuntime）存在；降级与测试是手写装配的那个。
  if (!runtime.runtime) return undefined;
  return new ModelRegistry(runtime.runtime as unknown as ModelRuntime) as unknown as ExtensionModelRegistry;
}

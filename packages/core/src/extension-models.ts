/**
 * 扩展的 `ctx.modelRegistry`：扩展自己调模型时（如 `pi-web-access` 的答案/摘要）
 * 只能从这里拿模型与凭证。
 *
 * 用官方 `ModelRegistry` 包住 `provider.ts` 的 `ModelRuntime`，凭证优先级、OAuth、
 * `baseUrl` 拼接、headers 全走官方逻辑 —— 自己实现只会得到一份会漂移的副本。
 *
 * `ModelRuntime.create()` 失败时（`runtime` 为 undefined）这里返回 `undefined`，不造一个
 * 假 registry：假 registry 会静默说「没有 key」，把「降级了」误报成「没配 key」。
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

/** 降级路径（手写装配的 runtime）返回 `undefined`，见文件头。 */
export function extensionModelRegistry(runtime: AgentRuntime): ExtensionModelRegistry | undefined {
  // 只有主路径有 runtime；降级与测试走手写装配。
  if (!runtime.runtime) return undefined;
  return new ModelRegistry(runtime.runtime as unknown as ModelRuntime) as unknown as ExtensionModelRegistry;
}

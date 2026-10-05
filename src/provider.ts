/**
 * Provider 装配 —— 与 DeepSeek Harness（my-pi-desktop）同一条路：
 * pi-ai 的 createModels + providers/deepseek 的 deepseekProvider，
 * 鉴权走 DEEPSEEK_API_KEY（provider 自带的 envApiKeyAuth）。
 */
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
  type Provider,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

export interface ProviderSpec {
  /** pi-ai provider id，如 "deepseek"。 */
  provider: string;
  /** 模型 id，如 "deepseek-v4-flash"；留空则用该 provider 的第一个模型。 */
  model?: string;
}

export interface AgentRuntime {
  models: Models;
  spec: ProviderSpec;
  /** 解析后的具体模型对象。 */
  model: Model<any>;
}

const PROVIDER_FACTORIES: Record<string, () => Provider<any>> = {
  deepseek: deepseekProvider as () => Provider<any>,
  anthropic: anthropicProvider as () => Provider<any>,
  openai: openaiProvider as () => Provider<any>,
};

export function providerNames(): string[] {
  return Object.keys(PROVIDER_FACTORIES);
}

/** 建运行时：注册 provider，按 spec 解析出 Model。 */
export function createRuntime(spec: ProviderSpec): AgentRuntime {
  const factory = PROVIDER_FACTORIES[spec.provider];
  if (!factory) {
    throw new Error(
      `未知 provider：${spec.provider}。可用：${providerNames().join(', ')}`,
    );
  }
  const models = createModels();
  models.setProvider(factory());
  const modelsOfProvider = models.getModels(spec.provider);
  const modelId = spec.model || modelsOfProvider[0]?.id;
  const model = modelId ? models.getModel(spec.provider, modelId) : undefined;
  if (!model) {
    const known = modelsOfProvider.map((m) => m.id).join(', ');
    throw new Error(
      `provider ${spec.provider} 下找不到模型 ${spec.model ?? '(默认)'}。可用：${known || '（无）'}`,
    );
  }
  return { models, spec: { ...spec, model: model.id }, model };
}

/**
 * streamFn 的形状就是 pi-ai 的 `StreamFunction`：给模型、一段 context、一些选项，
 * 拿回一个事件流。Agent Loop（effects.ts）只依赖这个形状，
 * 离线测试用假 streamFn 替换即可。
 */
export type StreamFn = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function defaultStreamFn(runtime: AgentRuntime): StreamFn {
  return (model, context, options) => runtime.models.streamSimple(model, context, options);
}

/** 这些 provider 不需要 API key。 */
const KEYLESS_PROVIDERS = new Set(['faux']);

/**
 * 取该 provider 的 API key：有就返回；没有而它免鉴权（faux）就返回 undefined；
 * 否则抛出可读的错误。
 */
export function resolveApiKey(provider: string): string | undefined {
  const envName = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const key = process.env[envName];
  if (key) return key;
  if (KEYLESS_PROVIDERS.has(provider)) return undefined;
  throw new Error(`缺少 ${envName} 环境变量（写进 .env 或 shell 里都行）。`);
}

// ─── 离线演示 provider（pi-ai 自带的 faux） ───

export interface FauxRuntime {
  runtime: AgentRuntime;
  setResponses(responses: AssistantMessage[]): void;
}

/** 造一个 faux 运行时：没有 API key 也能把整条 Agent Loop 跑通。 */
export function createFauxRuntime(): FauxRuntime {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return {
    runtime: { models, spec: { provider: 'faux', model: model.id }, model },
    setResponses: (responses) => faux.setResponses(responses),
  };
}

/** 演示脚本：先调工具算一道题，再复述结果 —— 走完整条环。 */
export function demoResponses(): AssistantMessage[] {
  return [
    fauxAssistantMessage(
      [fauxText('我来算一下。'), fauxToolCall('calc', { expression: '(3+4)*6' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('(3+4)*6 = 42。'),
  ];
}

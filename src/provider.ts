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
import {
  createModelsWithPiConfig,
  createPiModelRuntime,
  loadPiAuth,
  loadPiModels,
  loadPiSettings,
  piModelsPath,
  type PiModelRuntime,
} from './pi-config';

export interface ProviderSpec {
  /** pi-ai provider id，如 "deepseek"。 */
  provider: string;
  /** 模型 id，如 "deepseek-v4-flash"；留空则用该 provider 的第一个模型。 */
  model?: string;
}

export interface AgentRuntime {
  /**
   * 请求用的 Models。**主路径下就是 ModelRuntime 自己**（它 implements pi-ai 的 `Models`）。
   * 降级 / 测试下是手写装配的那个（见 pi-config.ts 的说明）。
   */
  models: Models;
  spec: ProviderSpec;
  /** 解析后的具体模型对象。 */
  model: Model<any>;
  /** 底下那个 ModelRuntime（仅主路径有；降级时 undefined）。 */
  runtime?: PiModelRuntime;
}

/**
 * 内置 provider 工厂（pi-ai 自带）。**只用于降级路径**。
 *
 * 主路径不用它们 —— `ModelRuntime` 自带 44 个内置 provider、1500+ 个模型目录
 * （anthropic / openai / deepseek / … 全带正确的 baseUrl、协议、价目表），
 * 比这里手列三个强得多，也不容易过期。
 */
const PROVIDER_FACTORIES: Record<string, () => Provider<any>> = {
  deepseek: deepseekProvider as () => Provider<any>,
  anthropic: anthropicProvider as () => Provider<any>,
  openai: openaiProvider as () => Provider<any>,
};

/** 默认 provider / 模型：从 `~/.pi/agent/settings.json` 读，读不到用这组兜底。 */
const FALLBACK_DEFAULT = { provider: 'workbuddy', model: 'cn:space-bunny' } as const;

/**
 * 默认 provider / 模型。
 *
 * 顺序：`~/.redux-agent/settings.json`（手写或从别处拷进来的）
 * → 内置兜底 `workbuddy` / `cn:space-bunny`。命令行显式给的参数永远优先。
 */
export function defaultProviderSpec(): ProviderSpec {
  const settings = loadPiSettings();
  return {
    provider: settings.defaultProvider ?? FALLBACK_DEFAULT.provider,
    model: settings.defaultModel ?? FALLBACK_DEFAULT.model,
  };
}

/**
 * 可用的 provider 名。
 *
 * 主路径下就是 `ModelRuntime` 自带的 44 个 + models.json 里的自定义；
 * 降级路径下是手列的三个内置 + models.json 里的自定义。
 * 读 models.json 失败不算错（可能还没迁移过），只是少列几个。
 */
export function providerNames(runtime?: PiModelRuntime): string[] {
  const custom = Object.keys(loadPiModels()?.providers ?? {});
  const builtins = runtime
    ? runtime.getProviders().map((p) => p.id)
    : Object.keys(PROVIDER_FACTORIES);
  return [...new Set([...builtins, ...custom])];
}

/**
 * 建运行时：注册 provider，按 spec 解析出 Model。
 *
 * ## 主路径：`ModelRuntime`
 *
 * 它自己读 models.json / auth.json、校验 schema、拼好凭证优先级，并自带 44 个内置
 * provider 的完整目录 —— 这些全是手写维护不来的。
 *
 * ## 降级：手写装配
 *
 * `ModelRuntime.create()` 失败时（配置坏到连它都起不来、版本不兼容等）退回
 * `createModelsWithPiConfig()`：至少还能用 models.json 里的自定义 provider，
 * 而不是整个起不来。降级信息写 stderr。
 */
export async function createRuntime(spec: ProviderSpec): Promise<AgentRuntime> {
  let models: Models;
  let runtime: PiModelRuntime | undefined;
  try {
    runtime = await createPiModelRuntime();
    models = runtime as unknown as Models;
  } catch (error) {
    process.stderr.write(
      `ModelRuntime 不可用，降级为手写装配（provider 会少很多）：${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    models = createModelsWithPiConfig(Object.values(PROVIDER_FACTORIES));
  }

  const modelsOfProvider = models.getModels(spec.provider);
  if (modelsOfProvider.length === 0) {
    throw new Error(
      `未知 provider：${spec.provider}。可用：${providerNames(runtime).join(', ')}` +
        `（自定义 provider 来自 ${piModelsPath()}）`,
    );
  }
  const modelId = spec.model || modelsOfProvider[0]?.id;
  const model = modelId ? models.getModel(spec.provider, modelId) : undefined;
  if (!model) {
    const known = modelsOfProvider.map((m) => m.id).join(', ');
    throw new Error(
      `provider ${spec.provider} 下找不到模型 ${spec.model ?? '(默认)'}。可用：${known || '（无）'}`,
    );
  }
  return { models, spec: { ...spec, model: model.id }, model, ...(runtime ? { runtime } : {}) };
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
  // 非字母数字的 provider id 要归一下（`my-gateway` → `MY_GATEWAY_API_KEY`），
  // 与 pi 的 envApiKeyAuth 规则一致。
  const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  // 再看 `~/.redux-agent/auth.json` ——
  // 这样即使项目 .env 里没有那个 key，配置家目录里的凭证也能用。
  const fromAuth = loadPiAuth()[provider]?.key;
  if (fromAuth) return fromAuth;
  if (KEYLESS_PROVIDERS.has(provider)) return undefined;
  throw new Error(
    `缺少 ${envName}。三处任选其一：` +
      `项目 .env、shell 环境变量、或 ~/.redux-agent/auth.json。`,
  );
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
      // 用官方的 bash 工具（来自 @earendil-works/pi-coding-agent）来算。
      [fauxText('我来算一下。'), fauxToolCall('bash', { command: 'echo $(((3+4)*6))' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('(3+4)*6 = 42。'),
  ];
}

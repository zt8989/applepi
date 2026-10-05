/**
 * 从 pi 的配置目录加载自定义 provider。
 *
 * ## 为什么要自己加载
 *
 * 本项目直接用 `pi-ai` 的 `createModels()`，不像 pi-coding-agent 那样经过
 * `ModelRuntime`（它会去读 `~/.pi/agent/models.json`）。所以这里补上那一层：
 * 读同一份 `models.json`、同一份 `auth.json`，用同样的路径规则
 * （`PI_CODING_AGENT_DIR` 可搬，默认 `~/.pi/agent`），然后用 pi-ai 的
 * `createProvider()` 把每个条目装配成真正的 `Provider`。
 *
 * 换句话说：**配置格式与路径跟 pi 完全一致**，只是读取代码是我们自己写的
 * —— 因为本项目不引 pi-agent-core 那套运行时。
 *
 * ## models.json 的形状
 *
 * ```json
 * { "providers": { "<id>": {
 *      "baseUrl": "http://…/v1",
 *      "api": "openai-completions",
 *      "models": { "<modelId>": {
 *          "id": "…", "api": "openai-completions",
 *          "contextWindow": 1000000, "maxTokens": 524288,
 *          "input": ["text"], "output": ["text"] } } } } }
 * ```
 *
 * ## auth.json 的形状
 *
 * ```json
 * { "<id>": { "type": "api_key", "key": "sk-…" } }
 * ```
 *
 * 注意 **baseUrl 不在这里** —— 它在 models.json 里。auth.json 只放凭证。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createProvider, createModels, type Model, type Models, type Provider } from '@earendil-works/pi-ai';
import { envApiKeyAuth } from '@earendil-works/pi-ai';
import { streamSimple as openaiCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as openaiResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';

/** pi 的配置目录（与 pi-coding-agent 的 `getAgentDir()` 同一套规则）。 */
export function piAgentDir(): string {
  const env = process.env['PI_CODING_AGENT_DIR'];
  return env ? path.resolve(env) : path.join(homedir(), '.pi', 'agent');
}

export function piModelsPath(): string {
  return path.join(piAgentDir(), 'models.json');
}

export function piAuthPath(): string {
  return path.join(piAgentDir(), 'auth.json');
}

export function piSettingsPath(): string {
  return path.join(piAgentDir(), 'settings.json');
}

/** models.json 里的一个 provider 条目（只声明我们真会用到的字段）。 */
export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Record<string, PiModelConfig>;
}

export interface PiModelConfig {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  output?: string[];
}

export interface PiModelsFile {
  providers: Record<string, PiProviderConfig>;
}

/** auth.json：`{ "<providerId>": { "type": "api_key", "key": "…" } }` */
export type PiAuthFile = Record<string, { type: string; key?: string }>;

function readJsonIfExists<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (error) {
    throw new Error(`读 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadPiModels(): PiModelsFile | null {
  return readJsonIfExists<PiModelsFile>(piModelsPath());
}

export function loadPiAuth(): PiAuthFile {
  return readJsonIfExists<PiAuthFile>(piAuthPath()) ?? {};
}

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}

export function loadPiSettings(): PiSettings {
  return readJsonIfExists<PiSettings>(piSettingsPath()) ?? {};
}

/**
 * 按 api 名取 streamSimple 实现。
 *
 * 只接三个 —— 它们覆盖了现网几乎所有的 OpenAI 兼容网关（本项目的 workbuddy 就是
 * `openai-completions`）。遇到别的 api 明确报错，不静默降级：猜错 api 会让请求
 * 发到错误的协议上，报错比错答好。
 */
function streamForApi(api: string): {
  streamSimple: (model: Model<any>, context: never, options?: never) => never;
} {
  switch (api) {
    case 'openai-completions':
      return { streamSimple: openaiCompletionsStreamSimple as never };
    case 'openai-responses':
      return { streamSimple: openaiResponsesStreamSimple as never };
    case 'anthropic-messages':
      return { streamSimple: anthropicStreamSimple as never };
    default:
      throw new Error(
        `暂不支持的 api：${api}。已支持 openai-completions / openai-responses / anthropic-messages。`,
      );
  }
}

/** 环境变量名：`<ID>_API_KEY`（同 pi 的 envApiKeyAuth 规则）。 */
function envVarFor(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * 把 models.json 里的一个条目装配成 pi-ai 的 `Provider`。
 *
 * auth 用 `envApiKeyAuth`：它按 `<ID>_API_KEY` 读环境变量，而 `npm start` 用了
 * `--env-file-if-exists=.env`，所以 key 从项目 `.env` 来。若 models.json 的条目里
 * 直接写了 `apiKey`，优先用它（自包含，不依赖环境）。
 */
export function buildProvider(
  providerId: string,
  config: PiProviderConfig,
  auth: PiAuthFile,
): Provider<any> {
  const api = config.api ?? 'openai-completions';
  const models: Model<any>[] = Object.values(config.models ?? {}).map((m) => ({
    ...m,
    id: m.id,
    provider: providerId,
    api: (m.api ?? api) as never,
    // baseUrl 可以按模型覆盖（多网关场景），否则沿用 provider 的。
    baseUrl: m.baseUrl ?? config.baseUrl,
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 32_000,
    reasoning: m.reasoning ?? false,
    // Model.cost 是必填的。自定义网关通常不给价目表，全 0 ——
    // 它只影响 usage 里的费用估算，不影响请求本身。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })) as unknown as Model<any>[];

  // `auth` 的形状是 `{ apiKey?: ApiKeyAuth }`，而 `ApiKeyAuth` 必须有 `resolve()`
  // （它返回 `{auth: {apiKey}}`）。显式 key（auth.json / 条目内 / 环境变量）都走
  // 同一个 resolve —— 手写一个「只认某个 key」的版本反而会漏掉 env 的那条路。
  //
  // 优先级：条目内 apiKey > auth.json 的 key > `<ID>_API_KEY` 环境变量。
  // `npm start` 用了 --env-file-if-exists=.env，所以 key 从项目 .env 来。
  const explicit = config.apiKey ?? auth[providerId]?.key;
  const envVar = envVarFor(providerId);
  const apiKeyAuth = explicit
    ? {
        name: config.name ?? providerId,
        async resolve() {
          return explicit ? { auth: { apiKey: explicit }, source: 'models.json' } : undefined;
        },
      }
    : envApiKeyAuth(config.name ?? providerId, [envVar]);

  return createProvider({
    id: providerId,
    name: config.name ?? providerId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
    auth: { apiKey: apiKeyAuth as never },
    models: models as never,
    api: { stream: (() => {
      throw new Error(`${providerId}：不提供流式 stream，只提供 streamSimple`);
    }) as never, ...streamForApi(api) } as never,
  });
}

/**
 * 把 models.json 里的**全部** provider 装进一个 `Models`。
 *
 * 返回的 Models 里既有自定义 provider（workbuddy 等），也已经有内置的
 * deepseek / anthropic / openai —— 调用方可以按 id 取。
 */
export function createModelsWithPiConfig(extra: (() => Provider<any>)[] = []): Models {
  const models = createModels();
  const file = loadPiModels();
  if (file) {
    const auth = loadPiAuth();
    for (const [providerId, config] of Object.entries(file.providers ?? {})) {
      try {
        models.setProvider(buildProvider(providerId, config, auth));
      } catch (error) {
        // 一个坏 provider 不该让全部不可用 —— 记下来继续。
        process.stderr.write(
          `跳过 provider ${providerId}：${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
  for (const factory of extra) {
    const provider = factory();
    models.setProvider(provider);
  }
  return models;
}

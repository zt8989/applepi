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
 * pi 新版要求 `models` 是**数组**：
 *
 * ```json
 * { "providers": { "<id>": {
 *      "baseUrl": "http://…/v1",
 *      "api": "openai-completions",
 *      "models": [ { "id": "…", "api": "openai-completions",
 *                    "contextWindow": 1000000, "maxTokens": 524288,
 *                    "input": ["text"], "output": ["text"] } ] } } }
 * ```
 *
 * 旧版（以及本项目早期）是**对象 map**：
 *
 * ```json
 * "models": { "<modelId>": { "id": "…", … } }
 * ```
 *
 * 两种都收（见 `normalizeModels()`）：pi 自己已经不支持后者，所以照抄 pi 的配置时
 * 只会碰到前者；而本项目的历史文件、以及给别的工具写的文件可能还是后者。
 * 搞错形状的表现是 pi 整个文件作废（一个 provider 都不装），不是某一个失败。
 *
 * ## auth.json 的形状
 *
 * ```json
 * { "<id>": { "type": "api_key", "key": "sk-…" } }
 * ```
 *
 * ## 与 pi 共用配置目录
 *
 * 配置家目录默认就是 pi 的 `~/.pi/agent`（`REDUX_AGENT_DIR` / `PI_CODING_AGENT_DIR`
 * 都能搬）。同一份 `models.json` / `auth.json` / `sessions/` 两边都能读写，
 * 改一边不会让另一边读不到 —— 格式与路径规则都照抄 pi（见 `config-home.ts`）。
 *
 * 代价是我们得自己读 `models.json`（pi-coding-agent 的 `ModelConfig` 有 `exports` 限制），
 * 所以校验也得自己做一层：读的时候容忍数组/对象两种形状，写的时候按 pi 现在的形状来。
 *
 * 注意 baseUrl 不在这里 —— 它在 models.json 里。auth.json 只放凭证。
 */
import { existsSync, readFileSync } from 'node:fs';
import { authPath, configHome, modelsPath, settingsPath, writeJson } from './config-home';
import path from 'node:path';
import { createProvider, createModels, type Model, type Models, type Provider } from '@earendil-works/pi-ai';
import { envApiKeyAuth } from '@earendil-works/pi-ai';
import { streamSimple as openaiCompletionsStreamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropicStreamSimple } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as openaiResponsesStreamSimple } from '@earendil-works/pi-ai/api/openai-responses';

/**
 * 配置家目录。默认与 pi 同址（`~/.pi/agent`），`REDUX_AGENT_DIR` 优先于
 * `PI_CODING_AGENT_DIR`。见 `config-home.ts`。
 */
export function piAgentDir(): string {
  return configHome();
}

export function piModelsPath(): string {
  return modelsPath();
}

export function piAuthPath(): string {
  return authPath();
}

export function piSettingsPath(): string {
  return settingsPath();
}

/**
 * models.json 里的一个 provider 条目（只声明我们真会用到的字段）。
 *
 * `models` 两种形状都收，见文件头的说明。
 */
export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** pi 新版：数组。旧版：`<modelId> → 定义` 的对象 map。 */
  models?: PiModelConfig[] | Record<string, PiModelConfig>;
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

/**
 * 归一成数组。**两种形状都收**：
 *
 *   数组（pi 新版）：`[{ "id": "…" }, …]`
 *   对象 map（旧版）：`{ "<modelId>": { "id": "…" }, … }`
 *
 * 为什么要收旧形状：pi 自己已经只认数组，所以搞错的后果是**整个 models.json 作废**
 * （`ModelConfig.load()` 报 schema 错误，一个 provider 都不装）。而本项目历史上写的
 * 配置、以及别人手写的配置都可能是 map。读的时候宽松一点，少一个「整个文件不可用」
 * 的坑；map 的 key 本来就等于 `id`，所以以 key 兜底、值里的 `id` 优先。
 */
export function normalizeModels(
  models: PiProviderConfig['models'],
): PiModelConfig[] {
  if (!models) return [];
  if (Array.isArray(models)) {
    return models.filter((m): m is PiModelConfig => !!m && typeof m === 'object');
  }
  return Object.entries(models).map(([modelId, model]) => {
    const value = model && typeof model === 'object' ? model : ({} as PiModelConfig);
    // 值里的 id 优先（它才是权威）；漏写时用 map 的 key 兵底。
    return value.id ? value : { ...value, id: modelId };
  });
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

/**
 * 读 models.json 并把它**归一 + 落盘**。
 *
 * 为什么要写回盘：旧的 `models: { map }` 形状 pi 不认，而 pi 读同一个文件
 * （配置家目录已改成与 pi 同址）—— 我们的文件用旧形状就会让 pi 整个加载失败。
 * 与其赌用户手写的是哪种，不如读的时候顺手改成 pi 现在的形状，一次性了事。
 *
 * 幂等：已是数组就什么都不做。写回失败也不抛 —— 内存里的配置已经能用（我们读的是
 * `normalizeModels()` 的结果），落盘只是为了下次和 pi 都能用。
 */
export function loadPiModelsNormalized(): PiModelsFile | null {
  const file = loadPiModels();
  if (!file) return null;
  let needsRewrite = false;
  for (const provider of Object.values(file.providers ?? {})) {
    if (provider?.models && !Array.isArray(provider.models)) needsRewrite = true;
  }
  if (needsRewrite) {
    try {
      writeJson(piModelsPath(), {
        ...file,
        providers: Object.fromEntries(
          Object.entries(file.providers ?? {}).map(([providerId, provider]) => [
            providerId,
            { ...provider, models: normalizeModels(provider.models) },
          ]),
        ),
      });
    } catch (error) {
      process.stderr.write(
        `models.json 形状已归一，但写回失败（不影响本次运行）：${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  return file;
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
  const models: Model<any>[] = normalizeModels(config.models).map((m) => ({
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
  // 走 loadPiModelsNormalized：顺手把旧形状的 models 改成 pi 现在的数组形状。
  const file = loadPiModelsNormalized();
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
